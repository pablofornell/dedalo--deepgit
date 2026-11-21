mod common;

use common::*;
use gitcore::files;
use gitcore::{GitError, IgnoreBlock, IgnoreTarget};

/// The message of an `Invalid` error; panics on any other kind.
fn invalid(e: GitError) -> String {
    match e {
        GitError::Invalid(m) => m,
        other => panic!("expected Invalid, got {other:?}"),
    }
}

const CHANGED: &str = "The file changed on disk. Reload it before you save.";

// ------------------------------------------------------------------ list

#[test]
fn list_has_tracked_and_untracked_files_and_leaves_out_ignored_and_deleted() {
    let repo = TestRepo::new();
    repo.commit_file(".gitignore", "*.log\ndist/\n", "ignore rules");
    repo.commit_file("src/main.rs", "fn main() {}\n", "main");
    repo.commit_file("README.md", "# Title\n", "readme");
    repo.commit_file("gone.txt", "bye\n", "to delete");
    std::fs::remove_file(repo.path().join("gone.txt")).expect("remove");
    repo.write("src/new.rs", "pub fn new() {}\n");
    repo.write("Zeta.txt", "upper case sorts first\n");
    repo.write("build.log", "ignored\n");
    repo.write("dist/out.js", "ignored\n");

    let list = files::list_files(&git(), &repo.info).expect("list");
    assert_eq!(
        list.files,
        vec![
            ".gitignore",
            "README.md",
            "Zeta.txt",
            "src/main.rs",
            "src/new.rs"
        ]
    );
    assert!(!list.truncated);
}

#[test]
fn list_reports_ignored_entries_and_a_whole_ignored_folder_as_one() {
    let repo = TestRepo::new();
    repo.commit_file("kept.log", "tracked although it matches\n", "kept");
    repo.commit_file(
        ".gitignore",
        "*.log\nnode_modules/\ntarget/\n",
        "ignore rules",
    );
    repo.commit_file("src/main.rs", "fn main() {}\n", "main");
    repo.write("build.log", "ignored\n");
    repo.write("src/debug.log", "ignored\n");
    repo.write("node_modules/pkg/deep/index.js", "ignored\n");
    repo.write("node_modules/pkg/package.json", "ignored\n");
    repo.write("target/debug/app", "ignored\n");
    repo.write("src/new.rs", "untracked, not ignored\n");

    let list = files::list_files(&git(), &repo.info).expect("list");
    assert_eq!(
        list.ignored,
        vec!["build.log", "node_modules/", "src/debug.log", "target/"]
    );
    // An ignored entry is not a file of the list. A tracked file that matches a rule stays a file.
    assert_eq!(
        list.files,
        vec![".gitignore", "kept.log", "src/main.rs", "src/new.rs"]
    );
}

#[test]
fn list_reports_a_folder_that_a_file_rule_ignores_as_one_entry() {
    let repo = TestRepo::new();
    repo.commit_file(".gitignore", "*.o\n", "ignore rules");
    repo.commit_file("src/main.c", "int main() {}\n", "main");
    for i in 0..30 {
        repo.write(&format!("out/deep/{i}.o"), "obj\n");
    }
    repo.write("out/top.o", "obj\n");
    // A folder with a file that is not ignored lists its ignored files one by one.
    repo.write("src/main.o", "obj\n");
    repo.write("mixed/keep.txt", "text\n");
    repo.write("mixed/a.o", "obj\n");

    let list = files::list_files(&git(), &repo.info).expect("list");
    assert_eq!(list.ignored, vec!["mixed/a.o", "out/", "src/main.o"]);
    assert!(!list.truncated);
}

#[test]
fn list_of_an_empty_repo_is_empty() {
    let repo = TestRepo::new();
    let list = files::list_files(&git(), &repo.info).expect("list");
    assert!(list.files.is_empty());
    assert!(list.ignored.is_empty());
    assert!(!list.truncated);
}

// ------------------------------------------------------------------ read

#[test]
fn read_returns_text_with_its_version() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "hello\r\nworld\r\n", "a");
    let f = files::read_text_file(&git(), &repo.info, "a.txt").expect("read");
    assert_eq!(f.content, "hello\r\nworld\r\n");
    assert!(!f.binary && !f.too_large);
    assert!(f.version.ends_with("-14"), "version {}", f.version);
}

#[test]
fn read_marks_a_nul_byte_or_invalid_utf8_as_binary() {
    let repo = TestRepo::new();
    std::fs::write(repo.path().join("nul.dat"), b"abc\0def").expect("write");
    std::fs::write(repo.path().join("bad.dat"), [0xff, 0xfe, b'a']).expect("write");
    for path in ["nul.dat", "bad.dat"] {
        let f = files::read_text_file(&git(), &repo.info, path).expect("read");
        assert!(f.binary, "{path} should be binary");
        assert!(f.content.is_empty());
        assert!(!f.too_large);
    }
}

#[test]
fn read_refuses_a_file_over_2_mib_but_takes_exactly_2_mib() {
    let repo = TestRepo::new();
    let limit = 2 * 1024 * 1024;
    std::fs::write(repo.path().join("exact.txt"), vec![b'a'; limit]).expect("write");
    std::fs::write(repo.path().join("big.txt"), vec![b'a'; limit + 1]).expect("write");

    let exact = files::read_text_file(&git(), &repo.info, "exact.txt").expect("read");
    assert!(!exact.too_large);
    assert_eq!(exact.content.len(), limit);

    let big = files::read_text_file(&git(), &repo.info, "big.txt").expect("read");
    assert!(big.too_large);
    assert!(big.content.is_empty());
    assert!(big.version.is_empty());
}

#[cfg(unix)]
#[test]
fn read_refuses_a_symlink() {
    let repo = TestRepo::new();
    repo.commit_file("README.md", "# Title\n", "readme");
    std::os::unix::fs::symlink("README.md", repo.path().join("link.md")).expect("symlink");
    let msg = invalid(files::read_text_file(&git(), &repo.info, "link.md").unwrap_err());
    assert_eq!(msg, "link.md is a symlink.");
}

#[test]
fn read_refuses_paths_outside_the_repo_and_the_git_folder() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "a\n", "a");
    let g = git();
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, "../outside.txt").unwrap_err()),
        "path outside the repo: ../outside.txt"
    );
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, "/etc/passwd").unwrap_err()),
        "path outside the repo: /etc/passwd"
    );
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, ".git/config").unwrap_err()),
        "path inside the git folder: .git/config"
    );
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, ".GIT/HEAD").unwrap_err()),
        "path inside the git folder: .GIT/HEAD"
    );
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, "").unwrap_err()),
        "No file path given."
    );
}

#[test]
fn read_refuses_a_folder_and_a_missing_file() {
    let repo = TestRepo::new();
    repo.commit_file("src/a.rs", "a\n", "a");
    let g = git();
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, "src").unwrap_err()),
        "not a regular file: src"
    );
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, "nope.txt").unwrap_err()),
        "file not found: nope.txt"
    );
}

// ------------------------------------------------------------------ write

#[test]
fn write_round_trips_and_returns_the_version_that_read_reports() {
    let repo = TestRepo::new();
    let g = git();
    let version = files::write_text_file(&g, &repo.info, "notes/todo.txt", "one\ntwo\n", None)
        .expect("write");
    assert_eq!(repo.read("notes/todo.txt"), "one\ntwo\n");
    let f = files::read_text_file(&g, &repo.info, "notes/todo.txt").expect("read");
    assert_eq!(f.content, "one\ntwo\n");
    assert_eq!(f.version, version);
}

#[test]
fn write_refuses_a_stale_version_and_keeps_the_disk_file() {
    let repo = TestRepo::new();
    let g = git();
    repo.commit_file("a.txt", "first\n", "a");
    let stale = files::read_text_file(&g, &repo.info, "a.txt")
        .expect("read")
        .version;
    files::write_text_file(&g, &repo.info, "a.txt", "second\n", Some(&stale)).expect("save");

    let err = files::write_text_file(&g, &repo.info, "a.txt", "third\n", Some(&stale));
    assert_eq!(invalid(err.unwrap_err()), CHANGED);
    assert_eq!(repo.read("a.txt"), "second\n");

    let current = files::read_text_file(&g, &repo.info, "a.txt")
        .expect("read")
        .version;
    files::write_text_file(&g, &repo.info, "a.txt", "third\n", Some(&current)).expect("save");
    assert_eq!(repo.read("a.txt"), "third\n");
}

#[test]
fn write_refuses_a_missing_file_when_a_version_was_expected() {
    let repo = TestRepo::new();
    let err = files::write_text_file(&git(), &repo.info, "gone.txt", "x", Some("abc-1"));
    assert_eq!(invalid(err.unwrap_err()), CHANGED);
    assert!(!repo.path().join("gone.txt").exists());
}

#[test]
fn write_keeps_crlf_bytes_exactly() {
    let repo = TestRepo::new();
    let g = git();
    files::write_text_file(&g, &repo.info, "win.txt", "a\r\nb\r\n", None).expect("write");
    let bytes = std::fs::read(repo.path().join("win.txt")).expect("read bytes");
    assert_eq!(bytes, b"a\r\nb\r\n");
}

#[test]
fn write_refuses_paths_outside_the_repo_and_the_git_folder() {
    let repo = TestRepo::new();
    let g = git();
    assert_eq!(
        invalid(files::write_text_file(&g, &repo.info, "../x.txt", "x", None).unwrap_err()),
        "path outside the repo: ../x.txt"
    );
    assert_eq!(
        invalid(
            files::write_text_file(&g, &repo.info, ".git/hooks/pre-commit", "x", None).unwrap_err()
        ),
        "path inside the git folder: .git/hooks/pre-commit"
    );
    assert!(!repo.path().join(".git/hooks/pre-commit").exists());
}

#[test]
fn write_refuses_a_folder_and_a_symlink() {
    let repo = TestRepo::new();
    let g = git();
    repo.commit_file("src/a.rs", "a\n", "a");
    assert_eq!(
        invalid(files::write_text_file(&g, &repo.info, "src", "x", None).unwrap_err()),
        "not a regular file: src"
    );
    #[cfg(unix)]
    {
        repo.commit_file("README.md", "# Title\n", "readme");
        std::os::unix::fs::symlink("README.md", repo.path().join("link.md")).expect("symlink");
        assert_eq!(
            invalid(files::write_text_file(&g, &repo.info, "link.md", "x", None).unwrap_err()),
            "link.md is a symlink."
        );
        assert_eq!(repo.read("README.md"), "# Title\n");
    }
}

// ------------------------------------------------------------------ ignore files

fn rules(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn ignore_creates_the_gitignore_and_hides_the_file() {
    let repo = TestRepo::new();
    let g = git();
    repo.write("src/gen/api.ts", "x\n");
    repo.write("src/keep.ts", "y\n");
    assert_eq!(
        files::read_ignore_file(&g, &repo.info, IgnoreTarget::Gitignore)
            .expect("read")
            .content,
        ""
    );
    let added = files::append_ignore_rules(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &rules(&["/src/gen/api.ts"]),
    )
    .expect("append");
    assert_eq!(added, vec!["/src/gen/api.ts"]);
    assert_eq!(repo.read(".gitignore"), "/src/gen/api.ts\n");
    let list = files::list_files(&g, &repo.info).expect("list");
    assert_eq!(list.files, vec![".gitignore", "src/keep.ts"]);
}

#[test]
fn ignore_adds_a_line_break_first_when_the_file_has_none_at_the_end() {
    let repo = TestRepo::new();
    let g = git();
    repo.write(".gitignore", "*.log");
    files::append_ignore_rules(&g, &repo.info, IgnoreTarget::Gitignore, &rules(&["dist/"]))
        .expect("append");
    assert_eq!(repo.read(".gitignore"), "*.log\ndist/\n");
}

#[test]
fn ignore_keeps_the_crlf_style_of_the_file() {
    let repo = TestRepo::new();
    let g = git();
    repo.write(".gitignore", "*.log\r\n");
    files::append_ignore_rules(&g, &repo.info, IgnoreTarget::Gitignore, &rules(&["dist/"]))
        .expect("append");
    assert_eq!(repo.read(".gitignore"), "*.log\r\ndist/\r\n");
}

#[test]
fn ignore_skips_a_line_that_is_there_already_and_repeated_lines() {
    let repo = TestRepo::new();
    let g = git();
    repo.write(".gitignore", "*.log\r\nbuild/\n");
    let added = files::append_ignore_rules(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &rules(&["*.log", "dist/", "dist/", "build/"]),
    )
    .expect("append");
    assert_eq!(added, vec!["dist/"]);
    assert_eq!(repo.read(".gitignore"), "*.log\r\nbuild/\ndist/\r\n");
    // Nothing new: the file does not change.
    let again =
        files::append_ignore_rules(&g, &repo.info, IgnoreTarget::Gitignore, &rules(&["dist/"]))
            .expect("append");
    assert!(again.is_empty());
    assert_eq!(repo.read(".gitignore"), "*.log\r\nbuild/\ndist/\r\n");
}

#[test]
fn ignore_writes_the_exclude_file_in_the_git_folder() {
    let repo = TestRepo::new();
    let g = git();
    repo.write("local.env", "secret\n");
    // `git init` makes `info/exclude`. A repo without it still works.
    let exclude = repo.path().join(".git/info/exclude");
    let _ = std::fs::remove_dir_all(repo.path().join(".git/info"));
    let added = files::append_ignore_rules(
        &g,
        &repo.info,
        IgnoreTarget::Exclude,
        &rules(&["/local.env"]),
    )
    .expect("append");
    assert_eq!(added, vec!["/local.env"]);
    assert_eq!(
        std::fs::read_to_string(&exclude).expect("exclude"),
        "/local.env\n"
    );
    assert!(!repo.path().join(".gitignore").exists());
    assert_eq!(
        files::read_ignore_file(&g, &repo.info, IgnoreTarget::Exclude)
            .expect("read")
            .content,
        "/local.env\n"
    );
    let list = files::list_files(&g, &repo.info).expect("list");
    assert!(list.files.is_empty());
}

#[test]
fn ignore_refuses_an_empty_pattern_and_a_line_break() {
    let repo = TestRepo::new();
    let g = git();
    for bad in ["", "   ", "a\nb", "a\rb", "a\0b"] {
        assert!(
            files::append_ignore_rules(&g, &repo.info, IgnoreTarget::Gitignore, &rules(&[bad]))
                .is_err(),
            "{bad:?}"
        );
    }
    assert!(!repo.path().join(".gitignore").exists());
}

#[cfg(unix)]
#[test]
fn ignore_refuses_a_symlink_and_a_folder() {
    let repo = TestRepo::new();
    let g = git();
    repo.write("real.txt", "x\n");
    std::os::unix::fs::symlink("real.txt", repo.path().join(".gitignore")).expect("symlink");
    let msg = invalid(
        files::append_ignore_rules(&g, &repo.info, IgnoreTarget::Gitignore, &rules(&["a"]))
            .unwrap_err(),
    );
    assert_eq!(msg, ".gitignore is a symlink.");
    assert_eq!(repo.read("real.txt"), "x\n");
    std::fs::remove_file(repo.path().join(".gitignore")).expect("remove");
    std::fs::create_dir(repo.path().join(".gitignore")).expect("dir");
    let msg =
        invalid(files::read_ignore_file(&g, &repo.info, IgnoreTarget::Gitignore).unwrap_err());
    assert_eq!(msg, "not a regular file: .gitignore");
}

#[test]
fn ignore_file_says_whether_the_repo_ignores_case() {
    let repo = TestRepo::new();
    let g = git();
    let read = |t| files::read_ignore_file(&g, &repo.info, t).expect("read");
    // False: case matters. (Git on Windows writes `true` at init, so set it first.)
    repo.sh(&["config", "core.ignorecase", "false"]);
    assert!(!read(IgnoreTarget::Gitignore).ignore_case);
    // True, also in the spellings that git reads as true.
    repo.sh(&["config", "core.ignorecase", "true"]);
    assert!(read(IgnoreTarget::Gitignore).ignore_case);
    assert!(read(IgnoreTarget::Exclude).ignore_case);
    repo.sh(&["config", "core.ignorecase", "yes"]);
    assert!(read(IgnoreTarget::Gitignore).ignore_case);
    // Unset: case matters.
    repo.sh(&["config", "--unset", "core.ignorecase"]);
    assert!(!read(IgnoreTarget::Gitignore).ignore_case);
}

// ------------------------------------------------------------------ the global ignore file

/// A git runner whose global ignore file is `home/.config/git/ignore` of a temp folder, so the
/// tests never touch the real one. The file does not exist yet.
fn git_with_global(home: &tempfile::TempDir) -> (gitcore::Git, std::path::PathBuf) {
    let file = home.path().join(".config/git/ignore");
    (git().with_global_ignore_file(file.clone()), file)
}

#[test]
fn global_ignore_creates_the_file_and_its_folder_and_applies_to_every_repo() {
    let home = tempfile::tempdir().expect("home");
    let (g, file) = git_with_global(&home);
    let repo = TestRepo::new();
    // The config of the test repo points git at the file, as a user would do (or git's default).
    repo.sh(&["config", "core.excludesFile", &file.to_string_lossy()]);
    repo.write("notes.swp", "x\n");
    repo.write("keep.txt", "y\n");
    let read = files::read_ignore_file(&g, &repo.info, IgnoreTarget::Global).expect("read");
    assert_eq!(read.content, "");
    assert_eq!(read.path, file.to_string_lossy());
    let added = files::append_ignore_rules(
        &g,
        &repo.info,
        IgnoreTarget::Global,
        &rules(&["*.swp", ".DS_Store"]),
    )
    .expect("append");
    assert_eq!(added, vec!["*.swp", ".DS_Store"]);
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "*.swp\n.DS_Store\n"
    );
    // Nothing was written in the repository.
    assert!(!repo.path().join(".gitignore").exists());
    assert_eq!(
        files::read_ignore_file(&g, &repo.info, IgnoreTarget::Global)
            .expect("read")
            .content,
        "*.swp\n.DS_Store\n"
    );
    // Git itself ignores the file now, in this repo and in another one.
    let list = files::list_files(&g, &repo.info).expect("list");
    assert_eq!(list.files, vec!["keep.txt"]);
    assert_eq!(list.ignored, vec!["notes.swp"]);
    let other = TestRepo::named("r2");
    other.sh(&["config", "core.excludesFile", &file.to_string_lossy()]);
    other.write("a.swp", "x\n");
    assert_eq!(
        files::list_files(&g, &other.info).expect("list").ignored,
        vec!["a.swp"]
    );
}

#[test]
fn global_ignore_skips_lines_that_are_there_and_keeps_the_line_end() {
    let home = tempfile::tempdir().expect("home");
    let (g, file) = git_with_global(&home);
    let repo = TestRepo::new();
    std::fs::create_dir_all(file.parent().unwrap()).expect("dir");
    std::fs::write(&file, "*.swp\r\n*.bak").expect("write");
    let added = files::append_ignore_rules(
        &g,
        &repo.info,
        IgnoreTarget::Global,
        &rules(&["*.swp", "*.tmp"]),
    )
    .expect("append");
    assert_eq!(added, vec!["*.tmp"]);
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "*.swp\r\n*.bak\r\n*.tmp\r\n"
    );
    // The same pattern is not added twice.
    assert!(
        files::append_ignore_rules(&g, &repo.info, IgnoreTarget::Global, &rules(&["*.tmp"]))
            .expect("append")
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn global_ignore_may_be_a_link_to_a_file_but_not_to_a_folder() {
    let home = tempfile::tempdir().expect("home");
    let (g, file) = git_with_global(&home);
    let repo = TestRepo::new();
    let real = home.path().join("dotfiles-ignore");
    std::fs::write(&real, "*.swp\n").expect("write");
    std::fs::create_dir_all(file.parent().unwrap()).expect("dir");
    std::os::unix::fs::symlink(&real, &file).expect("symlink");
    files::append_ignore_rules(&g, &repo.info, IgnoreTarget::Global, &rules(&["*.tmp"]))
        .expect("append");
    assert_eq!(
        std::fs::read_to_string(&real).expect("real"),
        "*.swp\n*.tmp\n"
    );
    assert_eq!(
        files::read_ignore_file(&g, &repo.info, IgnoreTarget::Global)
            .expect("read")
            .content,
        "*.swp\n*.tmp\n"
    );
    // A link to a folder is not a file.
    std::fs::remove_file(&file).expect("remove");
    std::os::unix::fs::symlink(home.path(), &file).expect("symlink");
    assert!(files::read_ignore_file(&g, &repo.info, IgnoreTarget::Global).is_err());
}

#[test]
fn the_real_global_ignore_path_is_absolute() {
    // Reads the git config of the machine. Writes nothing.
    let repo = TestRepo::new();
    let path = files::global_ignore_path(&git(), &repo.info);
    // No home folder is an error. Anywhere else the path is absolute.
    if let Ok(p) = path {
        assert!(p.is_absolute(), "{p:?}");
    }
}

// ------------------------------------------------------------------ templates (blocks of rules)

/// `append_ignore_blocks` with no template order: blocks only go to the end of the file.
fn append_blocks(
    g: &gitcore::Git,
    info: &gitcore::RepoInfo,
    target: IgnoreTarget,
    blocks: &[IgnoreBlock],
) -> Result<Vec<String>, GitError> {
    files::append_ignore_blocks(g, info, target, blocks, &[])
}

fn block(header: &str, list: &[&str]) -> IgnoreBlock {
    IgnoreBlock {
        header: header.to_string(),
        lines: rules(list),
    }
}

const RUST_HEAD: &str = "# --- DeepGit template: Rust ---";
const JAVA_HEAD: &str = "# --- DeepGit template: Java ---";

#[test]
fn blocks_are_added_with_a_header_and_an_empty_line_before_each() {
    let repo = TestRepo::new();
    let g = git();
    repo.write(".gitignore", "node_modules/\n");
    let added = append_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &[
            block(RUST_HEAD, &["# Cargo", "target/", "", "*.pdb"]),
            block(JAVA_HEAD, &["*.class"]),
        ],
    )
    .expect("blocks");
    assert_eq!(added, vec![RUST_HEAD, JAVA_HEAD]);
    assert_eq!(
        repo.read(".gitignore"),
        format!(
            "node_modules/\n\n{RUST_HEAD}\n# Cargo\ntarget/\n\n*.pdb\n\n{JAVA_HEAD}\n*.class\n"
        )
    );
}

#[test]
fn blocks_in_a_new_file_start_without_an_empty_line_and_finish_the_last_line() {
    let repo = TestRepo::new();
    let g = git();
    append_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &[block(RUST_HEAD, &["target/"])],
    )
    .expect("blocks");
    assert_eq!(repo.read(".gitignore"), format!("{RUST_HEAD}\ntarget/\n"));
    // A file without a line break at the end gets one, and the empty line. It keeps CRLF.
    repo.write(".gitignore", "*.log\r\nbuild");
    append_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &[block(JAVA_HEAD, &["*.class"])],
    )
    .expect("blocks");
    assert_eq!(
        repo.read(".gitignore"),
        format!("*.log\r\nbuild\r\n\r\n{JAVA_HEAD}\r\n*.class\r\n")
    );
}

#[test]
fn a_block_that_the_file_holds_is_skipped_and_known_patterns_are_left_out() {
    let repo = TestRepo::new();
    let g = git();
    repo.write(".gitignore", &format!("{RUST_HEAD}\ntarget/\n\n*.class\n"));
    let added = append_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &[
            // Same header: skipped, even with other lines.
            block(RUST_HEAD, &["target/", "new-rust/"]),
            // `*.class` is in the file: the comment above it goes too.
            block(
                JAVA_HEAD,
                &["# Classes", "*.class", "", "# Dumps", "hs_err_pid*"],
            ),
        ],
    )
    .expect("blocks");
    assert_eq!(added, vec![JAVA_HEAD]);
    assert_eq!(
        repo.read(".gitignore"),
        format!("{RUST_HEAD}\ntarget/\n\n*.class\n\n{JAVA_HEAD}\n# Dumps\nhs_err_pid*\n")
    );
    // The same call again changes nothing.
    let again = append_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &[block(JAVA_HEAD, &["# Dumps", "hs_err_pid*"])],
    )
    .expect("blocks");
    assert!(again.is_empty());
}

#[test]
fn a_block_with_no_new_pattern_is_not_added_and_a_pattern_is_not_repeated_between_blocks() {
    let repo = TestRepo::new();
    let g = git();
    repo.write(".gitignore", "target/\n");
    let added = append_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &[
            block(RUST_HEAD, &["target/"]),
            block(JAVA_HEAD, &["*.log"]),
            block("# --- DeepGit template: Python ---", &["*.log", "*.pyc"]),
        ],
    )
    .expect("blocks");
    assert_eq!(added, vec![JAVA_HEAD, "# --- DeepGit template: Python ---"]);
    assert_eq!(
        repo.read(".gitignore"),
        format!("target/\n\n{JAVA_HEAD}\n*.log\n\n# --- DeepGit template: Python ---\n*.pyc\n")
    );
}

#[test]
fn blocks_go_to_the_exclude_file_and_the_global_file() {
    let home = tempfile::tempdir().expect("home");
    let (g, file) = git_with_global(&home);
    let repo = TestRepo::new();
    let head = "# --- DeepGit template: macOS ---";
    append_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Global,
        &[block(head, &[".DS_Store"])],
    )
    .expect("global");
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        format!("{head}\n.DS_Store\n")
    );
    append_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Exclude,
        &[block(head, &[".DS_Store"])],
    )
    .expect("exclude");
    let exclude = std::fs::read_to_string(repo.path().join(".git/info/exclude")).expect("exclude");
    assert!(
        exclude.ends_with(&format!("\n{head}\n.DS_Store\n")),
        "{exclude:?}"
    );
    assert!(!repo.path().join(".gitignore").exists());
}

#[test]
fn blocks_refuse_a_header_that_is_not_a_comment_and_a_line_break() {
    let repo = TestRepo::new();
    let g = git();
    for bad in [
        block("target/", &["a"]),
        block(RUST_HEAD, &["a\nb"]),
        block("# a\nb", &["a"]),
        block(RUST_HEAD, &["a\0b"]),
    ] {
        assert!(append_blocks(&g, &repo.info, IgnoreTarget::Gitignore, &[bad]).is_err());
    }
    assert!(!repo.path().join(".gitignore").exists());
}

// ------------------------------------------------------------------ the order of the templates

const ORDER: [&str; 4] = [
    "# --- DeepGit template: Java ---",
    "# --- DeepGit template: Rust ---",
    "# --- DeepGit template: Gradle ---",
    "# --- DeepGit template: Linux ---",
];
const GRADLE_HEAD: &str = "# --- DeepGit template: Gradle ---";
const LINUX_HEAD: &str = "# --- DeepGit template: Linux ---";

fn order() -> Vec<String> {
    ORDER.iter().map(|s| s.to_string()).collect()
}

fn add_ordered(repo: &TestRepo, blocks: &[IgnoreBlock]) -> Vec<String> {
    files::append_ignore_blocks(
        &git(),
        &repo.info,
        IgnoreTarget::Gitignore,
        blocks,
        &order(),
    )
    .expect("blocks")
}

#[test]
fn a_new_block_goes_before_the_first_block_that_comes_later_in_the_order() {
    let repo = TestRepo::new();
    let gradle = block(GRADLE_HEAD, &["*.jar", "!gradle-wrapper.jar"]);
    repo.write("gradle/wrapper/gradle-wrapper.jar", "x\n");
    repo.write("libs/other.jar", "x\n");
    add_ordered(&repo, &[gradle]);
    // Java comes later: its `*.jar` must stand above the negation of Gradle, not under it.
    let added = add_ordered(
        &repo,
        &[block(JAVA_HEAD, &["# Archives", "*.jar", "*.war"])],
    );
    assert_eq!(added, vec![JAVA_HEAD]);
    // `*.jar` is in the file already (Gradle holds it): only the new line stays.
    assert_eq!(
        repo.read(".gitignore"),
        format!("{JAVA_HEAD}\n# Archives\n*.war\n\n{GRADLE_HEAD}\n*.jar\n!gradle-wrapper.jar\n")
    );
}

#[test]
fn a_late_java_block_does_not_hide_the_gradle_wrapper_jar() {
    let repo = TestRepo::new();
    repo.write("gradle/wrapper/gradle-wrapper.jar", "x\n");
    repo.write("libs/other.jar", "x\n");
    add_ordered(
        &repo,
        &[block(GRADLE_HEAD, &["# Wrapper", "!gradle-wrapper.jar"])],
    );
    add_ordered(&repo, &[block(JAVA_HEAD, &["*.jar"])]);
    let list = files::list_files(&git(), &repo.info).expect("list");
    assert!(list
        .files
        .contains(&"gradle/wrapper/gradle-wrapper.jar".to_string()));
    assert_eq!(list.ignored, vec!["libs/"]);
}

#[test]
fn blocks_keep_the_order_of_the_templates_inside_a_file_and_at_its_end() {
    let repo = TestRepo::new();
    repo.write(".gitignore", "mine/\n");
    // Linux first, then Rust and Java in one call, given out of order.
    add_ordered(&repo, &[block(LINUX_HEAD, &["*~"])]);
    let added = add_ordered(
        &repo,
        &[
            block(RUST_HEAD, &["target/"]),
            block(JAVA_HEAD, &["*.class"]),
        ],
    );
    assert_eq!(added, vec![JAVA_HEAD, RUST_HEAD]);
    assert_eq!(
        repo.read(".gitignore"),
        format!("mine/\n\n{JAVA_HEAD}\n*.class\n\n{RUST_HEAD}\ntarget/\n\n{LINUX_HEAD}\n*~\n")
    );
    // A block that has no later block ahead of it goes to the end.
    let more = add_ordered(
        &repo,
        &[block("# --- DeepGit template: Other ---", &["x/"])],
    );
    assert_eq!(more.len(), 1);
    assert!(repo
        .read(".gitignore")
        .ends_with("\n\n# --- DeepGit template: Other ---\nx/\n"));
}

#[test]
fn an_insert_in_the_middle_keeps_crlf_and_the_text_around() {
    let repo = TestRepo::new();
    repo.write(".gitignore", &format!("a\r\n{LINUX_HEAD}\r\n*~\r\nlast"));
    add_ordered(&repo, &[block(JAVA_HEAD, &["*.class"])]);
    assert_eq!(
        repo.read(".gitignore"),
        format!("a\r\n\r\n{JAVA_HEAD}\r\n*.class\r\n\r\n{LINUX_HEAD}\r\n*~\r\nlast")
    );
}

#[test]
fn a_block_is_not_inserted_again_and_unknown_headers_go_to_the_end() {
    let repo = TestRepo::new();
    repo.write(".gitignore", &format!("{LINUX_HEAD}\n*~\n"));
    add_ordered(&repo, &[block(JAVA_HEAD, &["*.class"])]);
    let text = repo.read(".gitignore");
    assert!(add_ordered(&repo, &[block(JAVA_HEAD, &["*.class", "*.new"])]).is_empty());
    assert_eq!(repo.read(".gitignore"), text);
}

// ------------------------------------------------------------------ the whole file is read

#[test]
fn a_write_refuses_an_ignore_file_over_2_mib_and_leaves_it_alone() {
    let repo = TestRepo::new();
    let g = git();
    // Over 2 MiB, with the pattern past the first 2 MiB and no line break at the end.
    let mut big = "x\n".repeat(1_100_000);
    big.push_str("dist/");
    repo.write(".gitignore", &big);
    let msg = invalid(
        files::append_ignore_rules(&g, &repo.info, IgnoreTarget::Gitignore, &rules(&["dist/"]))
            .unwrap_err(),
    );
    assert_eq!(msg, ".gitignore is larger than 2 MiB.");
    let msg = invalid(
        append_blocks(
            &g,
            &repo.info,
            IgnoreTarget::Gitignore,
            &[block(RUST_HEAD, &["target/"])],
        )
        .unwrap_err(),
    );
    assert_eq!(msg, ".gitignore is larger than 2 MiB.");
    assert_eq!(repo.read(".gitignore"), big);
    // A file just under 2 MiB still works, and its last line is seen.
    let mut ok = "x\n".repeat(1_048_573);
    ok.push_str("dist/");
    assert!(ok.len() <= 2 * 1024 * 1024);
    repo.write(".gitignore", &ok);
    let added = files::append_ignore_rules(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &rules(&["dist/", "new/"]),
    )
    .expect("append");
    assert_eq!(added, vec!["new/"]);
    assert!(repo.read(".gitignore").ends_with("dist/\nnew/\n"));
}

// ------------------------------------------------------------------ git's own config decides the global file

/// A git runner that sees only the config of a temp home: no system config, no `XDG_CONFIG_HOME`.
fn git_at_home(home: &std::path::Path) -> gitcore::Git {
    git()
        .with_env("HOME", home)
        .with_env("XDG_CONFIG_HOME", "")
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env("GIT_CONFIG_GLOBAL", "")
        .with_env("GIT_CONFIG_SYSTEM", "")
}

#[test]
fn the_global_file_follows_core_excludesfile_set_in_an_included_config() {
    let home = tempfile::tempdir().expect("home");
    let mine = home.path().join("rules").join("mine");
    // ~/.gitconfig only includes another file, which sets the excludes file.
    std::fs::write(
        home.path().join(".gitconfig"),
        "[include]\n\tpath = ~/extra.cfg\n",
    )
    .expect("gitconfig");
    std::fs::write(
        home.path().join("extra.cfg"),
        // Forward slashes: git reads a backslash in a config value as an escape.
        format!(
            "[core]\n\texcludesFile = {}\n",
            mine.display().to_string().replace('\\', "/")
        ),
    )
    .expect("extra");
    let g = {
        // The runner must not read the real GIT_CONFIG_GLOBAL: leave it unset so `~/.gitconfig` is read.
        git()
            .with_env("HOME", home.path())
            .with_env("XDG_CONFIG_HOME", "")
            .with_env("GIT_CONFIG_NOSYSTEM", "1")
    };
    let repo = TestRepo::new();
    repo.write("scratch.tmp", "x\n");
    repo.write("keep.txt", "y\n");
    assert_eq!(
        files::global_ignore_path(&g, &repo.info).expect("path"),
        mine
    );
    let added =
        files::append_ignore_rules(&g, &repo.info, IgnoreTarget::Global, &rules(&["*.tmp"]))
            .expect("append");
    assert_eq!(added, vec!["*.tmp"]);
    assert_eq!(std::fs::read_to_string(&mine).expect("mine"), "*.tmp\n");
    // The default file was not made: git would never read it.
    assert!(!home.path().join(".config/git/ignore").exists());
    // And git itself now ignores the path (it reads the same config).
    let list = files::list_files(&g, &repo.info).expect("list");
    assert_eq!(list.files, vec!["keep.txt"]);
    assert_eq!(list.ignored, vec!["scratch.tmp"]);
    assert_eq!(
        files::read_ignore_file(&g, &repo.info, IgnoreTarget::Global)
            .expect("read")
            .path,
        mine.to_string_lossy()
    );
}

#[test]
fn the_global_file_defaults_to_the_xdg_folder_and_never_changes_the_config() {
    let home = tempfile::tempdir().expect("home");
    let g = git_at_home(home.path());
    let repo = TestRepo::new();
    repo.write("a.swp", "x\n");
    let expected = home.path().join(".config/git/ignore");
    assert_eq!(
        files::global_ignore_path(&g, &repo.info).expect("path"),
        expected
    );
    // A file in the default place is read by git without any setting.
    files::append_ignore_rules(&g, &repo.info, IgnoreTarget::Global, &rules(&["*.swp"]))
        .expect("append");
    assert_eq!(std::fs::read_to_string(&expected).expect("file"), "*.swp\n");
    assert_eq!(
        files::list_files(&g, &repo.info).expect("list").ignored,
        vec!["a.swp"]
    );
    // No config file was made or changed.
    assert!(!home.path().join(".gitconfig").exists());
    // XDG_CONFIG_HOME moves it.
    let xdg = tempfile::tempdir().expect("xdg");
    let g2 = git_at_home(home.path()).with_env("XDG_CONFIG_HOME", xdg.path());
    assert_eq!(
        files::global_ignore_path(&g2, &repo.info).expect("path"),
        xdg.path().join("git/ignore")
    );
}

#[test]
fn a_repo_that_sets_its_own_excludes_file_is_reported() {
    let home = tempfile::tempdir().expect("home");
    let g = git_at_home(home.path());
    let repo = TestRepo::new();
    let read = || files::read_ignore_file(&g, &repo.info, IgnoreTarget::Global).expect("read");
    assert_eq!(read().local_excludes_file, None);
    repo.sh(&["config", "core.excludesFile", "/tmp/own-ignore"]);
    assert_eq!(
        read().local_excludes_file.as_deref(),
        Some("/tmp/own-ignore")
    );
    // The other targets do not report it.
    let other = files::read_ignore_file(&g, &repo.info, IgnoreTarget::Gitignore).expect("read");
    assert_eq!(other.local_excludes_file, None);
}

// ------------------------------------------------------------------ line ends, byte order mark, other encodings

#[test]
fn an_insert_keeps_every_existing_line_as_it_is_and_new_lines_use_the_dominant_end() {
    let repo = TestRepo::new();
    // More bare LF than CRLF: new lines use LF, and the CRLF lines stay CRLF.
    repo.write(".gitignore", &format!("a\nb\nc\n{LINUX_HEAD}\r\n*~\r\n"));
    add_ordered(&repo, &[block(JAVA_HEAD, &["*.class"])]);
    assert_eq!(
        repo.read(".gitignore"),
        format!("a\nb\nc\n\n{JAVA_HEAD}\n*.class\n\n{LINUX_HEAD}\r\n*~\r\n")
    );
    // More CRLF: new lines use CRLF, and the bare LF line stays LF.
    repo.write(
        ".gitignore",
        &format!("a\r\nb\r\nc\n{LINUX_HEAD}\r\n*~\r\n"),
    );
    add_ordered(&repo, &[block(JAVA_HEAD, &["*.class"])]);
    assert_eq!(
        repo.read(".gitignore"),
        format!("a\r\nb\r\nc\n\r\n{JAVA_HEAD}\r\n*.class\r\n\r\n{LINUX_HEAD}\r\n*~\r\n")
    );
}

#[test]
fn new_lines_at_the_end_of_a_mixed_file_use_the_dominant_end_too() {
    let repo = TestRepo::new();
    repo.write(".gitignore", "a\nb\nc\nd\r\ne");
    files::append_ignore_rules(&git(), &repo.info, IgnoreTarget::Gitignore, &rules(&["x/"]))
        .expect("append");
    assert_eq!(repo.read(".gitignore"), "a\nb\nc\nd\r\ne\nx/\n");
}

#[test]
fn a_byte_order_mark_stays_first_and_does_not_hide_the_first_line() {
    let repo = TestRepo::new();
    // The header is the first line: it is found, and a block goes above it behind the mark.
    repo.write(".gitignore", &format!("\u{feff}{LINUX_HEAD}\n*~\n"));
    assert!(add_ordered(&repo, &[block(LINUX_HEAD, &["*~", "new"])]).is_empty());
    add_ordered(&repo, &[block(JAVA_HEAD, &["*.class"])]);
    assert_eq!(
        repo.read(".gitignore"),
        format!("\u{feff}{JAVA_HEAD}\n*.class\n\n{LINUX_HEAD}\n*~\n")
    );
    // A first pattern behind the mark counts as held.
    repo.write(".gitignore", "\u{feff}target/\n");
    let g = git();
    assert!(files::append_ignore_rules(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &rules(&["target/"])
    )
    .expect("append")
    .is_empty());
    let added = append_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &[block(RUST_HEAD, &["target/", "*.pdb"])],
    )
    .expect("blocks");
    assert_eq!(added, vec![RUST_HEAD]);
    assert_eq!(
        repo.read(".gitignore"),
        format!("\u{feff}target/\n\n{RUST_HEAD}\n*.pdb\n")
    );
}

#[test]
fn a_file_that_is_not_utf8_only_grows_at_the_end_and_says_so() {
    let repo = TestRepo::new();
    let g = git();
    let mut bytes = format!("{LINUX_HEAD}\n*~\n# caf").into_bytes();
    bytes.extend_from_slice(&[0xE9, b'\n']); // Latin-1 e acute
    std::fs::write(repo.path().join(".gitignore"), &bytes).expect("write");
    let read = files::read_ignore_file(&g, &repo.info, IgnoreTarget::Gitignore).expect("read");
    assert!(!read.can_insert);
    // Java comes before Linux in the order, but the bytes of the file stay: it goes to the end.
    let added = files::append_ignore_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Gitignore,
        &[block(JAVA_HEAD, &["*.class"])],
        &order(),
    )
    .expect("blocks");
    assert_eq!(added, vec![JAVA_HEAD]);
    let mut want = bytes.clone();
    want.extend_from_slice(format!("\n{JAVA_HEAD}\n*.class\n").as_bytes());
    assert_eq!(
        std::fs::read(repo.path().join(".gitignore")).expect("read"),
        want
    );
    // A text file can be inserted into.
    repo.write(".gitignore", "a\n");
    let read = files::read_ignore_file(&g, &repo.info, IgnoreTarget::Gitignore).expect("read");
    assert!(read.can_insert);
}

#[test]
fn the_headers_that_come_back_have_no_trailing_space() {
    let repo = TestRepo::new();
    let added = add_ordered(&repo, &[block(&format!("{JAVA_HEAD}  "), &["*.class"])]);
    assert_eq!(added, vec![JAVA_HEAD]);
    assert_eq!(repo.read(".gitignore"), format!("{JAVA_HEAD}\n*.class\n"));
}

// ------------------------------------------------------------------ an insert is a safe write

#[cfg(unix)]
#[test]
fn an_insert_keeps_the_permissions_and_leaves_no_temporary_file() {
    use std::os::unix::fs::PermissionsExt;
    let repo = TestRepo::new();
    let file = repo.path().join(".gitignore");
    repo.write(".gitignore", &format!("{LINUX_HEAD}\n*~\n"));
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    add_ordered(&repo, &[block(JAVA_HEAD, &["*.class"])]);
    let mode = std::fs::metadata(&file).expect("meta").permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let names: Vec<String> = std::fs::read_dir(repo.path())
        .expect("dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("deepgit"))
        .collect();
    assert!(names.is_empty(), "{names:?}");
}

#[cfg(unix)]
#[test]
fn an_insert_into_a_linked_global_file_writes_the_target_and_keeps_the_link() {
    let home = tempfile::tempdir().expect("home");
    let (g, file) = git_with_global(&home);
    let repo = TestRepo::new();
    let real = home.path().join("dotfiles/ignore");
    std::fs::create_dir_all(real.parent().unwrap()).expect("dir");
    std::fs::write(&real, format!("{LINUX_HEAD}\n*~\n")).expect("write");
    std::fs::create_dir_all(file.parent().unwrap()).expect("dir");
    std::os::unix::fs::symlink(&real, &file).expect("symlink");
    files::append_ignore_blocks(
        &g,
        &repo.info,
        IgnoreTarget::Global,
        &[block(JAVA_HEAD, &["*.class"])],
        &order(),
    )
    .expect("blocks");
    assert!(std::fs::symlink_metadata(&file).expect("meta").is_symlink());
    assert_eq!(
        std::fs::read_to_string(&real).expect("real"),
        format!("{JAVA_HEAD}\n*.class\n\n{LINUX_HEAD}\n*~\n")
    );
    // No temporary file next to the real file.
    let others: Vec<_> = std::fs::read_dir(real.parent().unwrap())
        .expect("dir")
        .collect();
    assert_eq!(others.len(), 1);
}

#[test]
fn writers_of_the_global_file_do_not_lose_each_others_blocks() {
    let home = tempfile::tempdir().expect("home");
    let (g, file) = git_with_global(&home);
    std::fs::create_dir_all(file.parent().unwrap()).expect("dir");
    // The last template is in the file: every other block goes inside it, so each write is a rewrite.
    std::fs::write(&file, format!("{LINUX_HEAD}\n*~\n")).expect("write");
    let heads: Vec<String> = (0..8)
        .map(|i| format!("# --- DeepGit template: T{i} ---"))
        .collect();
    let mut order: Vec<String> = heads.clone();
    order.push(LINUX_HEAD.to_string());
    let repos: Vec<TestRepo> = (0..8).map(|i| TestRepo::named(&format!("r{i}"))).collect();
    std::thread::scope(|scope| {
        for (i, repo) in repos.iter().enumerate() {
            let (g, order, head) = (g.clone(), order.clone(), heads[i].clone());
            scope.spawn(move || {
                let b = IgnoreBlock {
                    header: head,
                    lines: vec![format!("rule{i}/")],
                };
                files::append_ignore_blocks(&g, &repo.info, IgnoreTarget::Global, &[b], &order)
                    .expect("blocks");
            });
        }
    });
    let text = std::fs::read_to_string(&file).expect("file");
    for (i, h) in heads.iter().enumerate() {
        assert!(text.contains(&format!("{h}\nrule{i}/\n")), "{text}");
    }
    assert!(text.ends_with(&format!("{LINUX_HEAD}\n*~\n")));
    // Each block stands once, above Linux.
    assert_eq!(text.matches("DeepGit template").count(), 9);
}
