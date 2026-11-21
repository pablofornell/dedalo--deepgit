//! Project files: list, read and write the files of the worktree. Every path is relative
//! to the repo root. The list keeps the ignored files apart in `ignored`.
//! Read and write still accept a path to an ignored file. The ignore file functions are the only
//! ones that touch `.git/info/exclude`.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::ffi::OsString;
use std::io::Read;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use crate::conflicts::write_worktree_file;
use crate::diff::{worktree_path, MAX_CONTENT_BYTES};
use crate::error::GitError;
use crate::model::{FileList, IgnoreBlock, IgnoreFile, IgnoreTarget, RepoInfo, TextFile};
use crate::ops::check_rel;
use crate::runner::Git;

/// `list_files` returns at most this many paths.
pub const MAX_LISTED_FILES: usize = 100_000;
/// Treat a file with a NUL byte in its first bytes as binary (the rule of git).
const BINARY_SCAN_BYTES: usize = 8000;

/// List the tracked and untracked files that are not ignored, sorted by path. Leave out a tracked
/// file that is gone from the disk, and a submodule folder. `ignored` lists the ignored entries: a
/// folder that is ignored as a whole is one entry that ends with "/", and the entries inside it are
/// left out. `truncated` is also set when the ignored list had to stop at `MAX_LISTED_FILES`.
pub fn list_files(git: &Git, repo: &RepoInfo) -> Result<FileList, GitError> {
    let root = Path::new(&repo.path);
    let args = [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
    ];
    let out = git.run(root, Some(&repo.id), &args, false)?;
    let found: BTreeSet<String> = out
        .stdout
        .split('\0')
        .filter(|p| !p.is_empty() && is_on_disk(root, p))
        .map(str::to_string)
        .collect();
    // `--directory` shows an untracked folder as one entry only when a folder rule ignores it. With a
    // file rule (`*.o`) git also lists every file inside. The records are read one by one, so a
    // build folder with a million files does not fill the memory: the entries inside a listed
    // folder are dropped at once, and the read stops at the cap.
    let args = [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
    ];
    let mut ignored = IgnoredEntries::new(MAX_LISTED_FILES);
    git.run_records(root, Some(&repo.id), &args, |p| ignored.push(p))?;
    let (ignored, ignored_truncated) = ignored.finish();
    Ok(cap_list(
        found,
        ignored,
        ignored_truncated,
        MAX_LISTED_FILES,
    ))
}

/// The first `max` files. `truncated` says that there were more files, or that the ignored list stopped.
fn cap_list(
    found: BTreeSet<String>,
    ignored: BTreeSet<String>,
    ignored_truncated: bool,
    max: usize,
) -> FileList {
    let truncated = found.len() > max || ignored_truncated;
    FileList {
        files: found.into_iter().take(max).collect(),
        ignored: ignored.into_iter().take(max).collect(),
        truncated,
    }
}

/// Collects the ignored entries that git prints. An entry inside an ignored folder that is
/// already in the list is dropped. Stops at `max` entries.
struct IgnoredEntries {
    max: usize,
    kept: BTreeSet<String>,
    /// The folder entries (they end with "/") that are in `kept`.
    dirs: HashSet<String>,
    truncated: bool,
}

impl IgnoredEntries {
    fn new(max: usize) -> Self {
        IgnoredEntries {
            max,
            kept: BTreeSet::new(),
            dirs: HashSet::new(),
            truncated: false,
        }
    }

    /// Takes one entry. Returns false when the list is full: the caller stops reading.
    fn push(&mut self, path: &str) -> bool {
        let inside = path
            .match_indices('/')
            .any(|(i, _)| i + 1 < path.len() && self.dirs.contains(&path[..=i]));
        if inside {
            return true;
        }
        if self.kept.len() >= self.max {
            self.truncated = true;
            return false;
        }
        if path.ends_with('/') {
            self.dirs.insert(path.to_string());
        }
        self.kept.insert(path.to_string());
        true
    }

    /// The entries and the truncation flag. Git can print a folder after some of its entries, so
    /// this drops what lies inside a folder entry once more, on the sorted list.
    fn finish(self) -> (BTreeSet<String>, bool) {
        let mut out = BTreeSet::new();
        let mut last_dir: Option<&str> = None;
        for p in &self.kept {
            if last_dir.is_some_and(|d| p.starts_with(d)) {
                continue;
            }
            if p.ends_with('/') {
                last_dir = Some(p);
            }
            out.insert(p.clone());
        }
        (out, self.truncated)
    }
}

/// Count a regular file or a symlink as on disk. List a symlink even when its target is gone.
fn is_on_disk(root: &Path, rel: &str) -> bool {
    std::fs::symlink_metadata(root.join(rel)).is_ok_and(|m| m.is_file() || m.is_symlink())
}

/// Read a worktree file as text. A file over 2 MiB, or a binary one, gives empty content and a flag.
/// Refuse a symlink.
pub fn read_text_file(_git: &Git, repo: &RepoInfo, path: &str) -> Result<TextFile, GitError> {
    check_path(path)?;
    let full = worktree_path(repo, path)?;
    check_regular(&full, path)?;
    let mut bytes = Vec::new();
    std::fs::File::open(&full)?
        .take(MAX_CONTENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CONTENT_BYTES {
        return Ok(TextFile {
            content: String::new(),
            version: String::new(),
            binary: false,
            too_large: true,
        });
    }
    let version = version_of(&bytes);
    let nul = bytes[..bytes.len().min(BINARY_SCAN_BYTES)].contains(&0);
    let text = if nul {
        None
    } else {
        String::from_utf8(bytes).ok()
    };
    let binary = text.is_none();
    Ok(TextFile {
        content: text.unwrap_or_default(),
        version,
        binary,
        too_large: false,
    })
}

/// Save the bytes of `content` to a worktree file. Line endings do not change. Return the new
/// version. With `expected_version`, refuse a file that changed since that version. Create a
/// missing file. With an expected version, refuse a missing file too.
pub fn write_text_file(
    _git: &Git,
    repo: &RepoInfo,
    path: &str,
    content: &str,
    expected_version: Option<&str>,
) -> Result<String, GitError> {
    check_path(path)?;
    let full = worktree_path(repo, path)?;
    match std::fs::symlink_metadata(&full) {
        Ok(_) => {
            check_regular(&full, path)?;
            let current = version_of(&std::fs::read(&full)?);
            if expected_version.is_some_and(|v| v != current) {
                return Err(changed_on_disk());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if expected_version.is_some() {
                return Err(changed_on_disk());
            }
        }
        Err(e) => return Err(e.into()),
    }
    write_worktree_file(Path::new(&repo.path), path, content.as_bytes(), false)?;
    Ok(version_of(content.as_bytes()))
}

fn changed_on_disk() -> GitError {
    GitError::Invalid("The file changed on disk. Reload it before you save.".to_string())
}

/// Read the text of an ignore file, its path, and the case rule of the repo (`core.ignorecase`, false
/// when unset). A missing file gives an empty text. Refuse a symlink (except for the global file, which
/// may link to a file) and a folder, and a file over 2 MiB. For the global file, `local_excludes_file`
/// holds the `core.excludesFile` that the repo sets for itself: git reads that file here, not the global one.
pub fn read_ignore_file(
    git: &Git,
    repo: &RepoInfo,
    target: IgnoreTarget,
) -> Result<IgnoreFile, GitError> {
    let (content, can_insert) = read_ignore_text(git, repo, target)?;
    let local_excludes_file = if target == IgnoreTarget::Global {
        local_excludes_file(git, repo)?
    } else {
        None
    };
    Ok(IgnoreFile {
        content,
        path: ignore_file_path(git, repo, target)?
            .to_string_lossy()
            .into_owned(),
        ignore_case: core_ignorecase(git, repo)?,
        local_excludes_file,
        can_insert,
    })
}

/// The `core.excludesFile` that the config of the repo itself sets (`git config --local`), if any.
fn local_excludes_file(git: &Git, repo: &RepoInfo) -> Result<Option<String>, GitError> {
    let args = [
        "config",
        "--local",
        "--includes",
        "--get",
        "core.excludesFile",
    ];
    let out = git.run_unchecked(Path::new(&repo.path), Some(&repo.id), &args, false, None)?;
    let value = out.stdout.trim_end_matches(['\n', '\r']).trim();
    Ok((out.code == 0 && !value.is_empty()).then(|| value.to_string()))
}

/// The value of `core.ignorecase`. Git exits with 1 when the key is not set: that means false.
fn core_ignorecase(git: &Git, repo: &RepoInfo) -> Result<bool, GitError> {
    let args = ["config", "--type=bool", "--get", "core.ignorecase"];
    let out = git.run_unchecked(Path::new(&repo.path), Some(&repo.id), &args, false, None)?;
    Ok(out.code == 0 && out.stdout.trim() == "true")
}

/// The text of an ignore file, and whether a template can go inside it (`can_insert`): only a UTF-8 file is
/// written again as a whole, any other grows at its end.
fn read_ignore_text(
    git: &Git,
    repo: &RepoInfo,
    target: IgnoreTarget,
) -> Result<(String, bool), GitError> {
    let full = ignore_file_path(git, repo, target)?;
    let label = ignore_label(target, &full);
    let bytes = read_existing(&full, target, &label)?;
    let can_insert = std::str::from_utf8(&bytes).is_ok();
    Ok((String::from_utf8_lossy(&bytes).into_owned(), can_insert))
}

/// One writer at a time for the global ignore file: every repo of the app writes the same file, and each
/// repo has a lock of its own only.
static GLOBAL_IGNORE_LOCK: Mutex<()> = Mutex::new(());

fn global_lock(target: IgnoreTarget) -> Option<MutexGuard<'static, ()>> {
    (target == IgnoreTarget::Global)
        .then(|| GLOBAL_IGNORE_LOCK.lock().unwrap_or_else(|e| e.into_inner()))
}

/// The lines of an ignore text, to compare. A UTF-8 byte order mark before the first line is not part of it
/// (git skips it too).
fn text_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.lines().collect();
    if let Some(first) = lines.first_mut() {
        *first = first.strip_prefix('\u{feff}').unwrap_or(first);
    }
    lines
}

/// The line end for new lines: `\r\n` when the file has at least as many `\r\n` as bare `\n` line ends (and one at
/// least), else `\n`. A file that mixes both keeps its lines as they are.
fn dominant_eol(bytes: &[u8]) -> &'static str {
    let lf = bytes.iter().filter(|b| **b == b'\n').count();
    let crlf = bytes.windows(2).filter(|w| *w == b"\r\n").count();
    if crlf > 0 && crlf >= lf - crlf {
        "\r\n"
    } else {
        "\n"
    }
}

/// The bytes of an ignore file. Empty when the file does not exist. A file over 2 MiB is refused, whether it
/// is read or written to: a write must see the whole file to find its last line and the lines it has.
fn read_existing(full: &Path, target: IgnoreTarget, label: &str) -> Result<Vec<u8>, GitError> {
    match std::fs::symlink_metadata(full) {
        Ok(_) => check_ignore_file(full, target, label)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    }
    let mut bytes = Vec::new();
    std::fs::File::open(full)?
        .take(MAX_CONTENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CONTENT_BYTES {
        return Err(GitError::Invalid(format!("{label} is larger than 2 MiB.")));
    }
    Ok(bytes)
}

/// Refuse an ignore file that is not a regular file. The global file may be a link (people keep their
/// dotfiles in a repository and link them), so a link to a regular file is fine there.
fn check_ignore_file(full: &Path, target: IgnoreTarget, label: &str) -> Result<(), GitError> {
    if target != IgnoreTarget::Global {
        return check_regular(full, label);
    }
    match std::fs::metadata(full) {
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err(GitError::Invalid(format!("not a regular file: {label}"))),
        Err(e) => Err(e.into()),
    }
}

/// Add pattern lines at the end of an ignore file. Create the file (and its folder) when it
/// is missing. Add a line break first when the file does not end with one. New lines use `\r\n`
/// when the file already does. Skip a line that the file holds already, and a repeated one.
/// Return the lines that were added. Do not stage and do not commit.
pub fn append_ignore_rules(
    git: &Git,
    repo: &RepoInfo,
    target: IgnoreTarget,
    patterns: &[String],
) -> Result<Vec<String>, GitError> {
    for p in patterns {
        if p.trim().is_empty() {
            return Err(GitError::Invalid("A pattern cannot be empty.".to_string()));
        }
        check_line(p)?;
    }
    let _lock = global_lock(target);
    let full = ignore_file_path(git, repo, target)?;
    let label = ignore_label(target, &full);
    let existing = read_existing(&full, target, &label)?;
    let text = String::from_utf8_lossy(&existing);
    let mut known: BTreeSet<&str> = text_lines(&text).into_iter().collect();
    let mut added = Vec::new();
    for p in patterns {
        if known.insert(p.as_str()) {
            added.push(p.clone());
        }
    }
    if !added.is_empty() {
        write_lines(&full, &existing, &added)?;
    }
    Ok(added)
}

/// Add blocks of rules (templates) to an ignore file. `order` lists the headers of all templates in their
/// canonical order. A new block goes before the first block of the file with a later place in `order`
/// (the file keeps the order of the templates, so a later `*.jar` cannot hide the `!gradle-wrapper.jar` of
/// a block above), else at the end after an empty line. Each block is its `header` line and its lines. A
/// block whose header the file holds already is skipped. A pattern that the file holds already, or an
/// earlier block of this call, is left out, with the comment above it when no pattern is left under that
/// comment. A block with no new pattern is skipped. Create the file (and its folder) when it is missing.
/// Return the headers of the blocks that were added, in the order of `order`. Do not stage and do not commit.
pub fn append_ignore_blocks(
    git: &Git,
    repo: &RepoInfo,
    target: IgnoreTarget,
    blocks: &[IgnoreBlock],
    order: &[String],
) -> Result<Vec<String>, GitError> {
    for b in blocks {
        if !b.header.starts_with('#') {
            return Err(GitError::Invalid(
                "The header of a block must be a comment.".to_string(),
            ));
        }
        check_line(&b.header)?;
        b.lines.iter().try_for_each(|l| check_line(l))?;
    }
    let _lock = global_lock(target);
    let full = ignore_file_path(git, repo, target)?;
    let label = ignore_label(target, &full);
    let existing = read_existing(&full, target, &label)?;
    let text = String::from_utf8_lossy(&existing);
    let old: Vec<&str> = text_lines(&text);
    let mut known: BTreeSet<String> = old.iter().map(|l| l.to_string()).collect();
    let rank = |h: &str| order.iter().position(|o| o.trim_end() == h.trim_end());
    // The template blocks of the file: the line of the header, and the place in `order`.
    let have: Vec<(usize, usize)> = old
        .iter()
        .enumerate()
        .filter_map(|(i, l)| rank(l).map(|r| (i, r)))
        .collect();
    // A file that is not UTF-8 only grows at the end: a rewrite would change its bytes.
    let can_insert = std::str::from_utf8(&existing).is_ok();
    let mut sorted: Vec<&IgnoreBlock> = blocks.iter().collect();
    sorted.sort_by_key(|b| rank(&b.header).unwrap_or(usize::MAX));
    let mut inside: BTreeMap<usize, Vec<Vec<String>>> = BTreeMap::new();
    let mut end: Vec<Vec<String>> = Vec::new();
    let mut added = Vec::new();
    for b in sorted {
        let header = b.header.trim_end();
        if old.iter().any(|l| l.trim_end() == header) {
            continue;
        }
        let lines = tidy_block(&b.lines, &mut known);
        if lines.is_empty() {
            continue;
        }
        let mut block = vec![header.to_string()];
        block.extend(lines);
        let spot = rank(header)
            .filter(|_| can_insert)
            .and_then(|r| have.iter().find(|(_, other)| *other > r));
        match spot {
            Some((line, _)) => inside.entry(*line).or_default().push(block),
            None => end.push(block),
        }
        added.push(header.to_string());
    }
    if added.is_empty() {
        return Ok(added);
    }
    let gap = old.last().is_some_and(|l| !l.trim().is_empty());
    let mut tail: Vec<String> = Vec::new();
    for (i, block) in end.into_iter().enumerate() {
        if i > 0 || gap {
            tail.push(String::new());
        }
        tail.extend(block);
    }
    if inside.is_empty() {
        write_lines(&full, &existing, &tail)?;
        return Ok(added);
    }
    // Blocks go inside the file: write all of it again. The lines it has stay as they are, byte for byte
    // (also a line end that differs from the rest); the new lines use the line end of the file.
    let eol = dominant_eol(&existing);
    let mut out: Vec<u8> = Vec::new();
    let put = |out: &mut Vec<u8>, line: &str| {
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(eol.as_bytes());
    };
    let mut last_open = false;
    // A byte order mark stays at the very start of the file.
    let (bom, body) = match existing.strip_prefix(b"\xEF\xBB\xBF") {
        Some(rest) => (&existing[..3], rest),
        None => (&existing[..0], &existing[..]),
    };
    out.extend_from_slice(bom);
    for (i, raw) in body.split_inclusive(|b| *b == b'\n').enumerate() {
        if let Some(blocks) = inside.get(&i) {
            if i > 0 && !old[i - 1].trim().is_empty() {
                put(&mut out, "");
            }
            for block in blocks {
                block.iter().for_each(|l| put(&mut out, l));
                put(&mut out, "");
            }
        }
        out.extend_from_slice(raw);
        last_open = !raw.ends_with(b"\n");
    }
    if !tail.is_empty() && last_open {
        out.extend_from_slice(eol.as_bytes());
    }
    tail.iter().for_each(|l| put(&mut out, l));
    replace_file(&full, target, &label, &existing, &out)?;
    Ok(added)
}

/// Write `bytes` as the new content of an ignore file that held `before` when it was read, so that a crash or
/// a full disk cannot leave it empty: write a temporary file in the folder of the real file (a link of the
/// global file is followed), flush it to the disk, give it the permissions of the file, and rename it over.
/// Refuse when the file is not `before` any more (an editor saved it, or another program wrote to it).
fn replace_file(
    full: &Path,
    target: IgnoreTarget,
    label: &str,
    before: &[u8],
    bytes: &[u8],
) -> Result<(), GitError> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let real = std::fs::canonicalize(full)?;
    if read_existing(full, target, label)? != before {
        return Err(GitError::Invalid(format!(
            "{label} changed while DeepGit was working. Try again."
        )));
    }
    let perms = std::fs::metadata(&real)?.permissions();
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned());
    let tmp = real.with_file_name(format!(
        ".{}.deepgit-{}-{}.tmp",
        name.unwrap_or_default(),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let write = || -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        // The permissions come first: a private file is never written to a file that others can read.
        file.set_permissions(perms.clone())?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, &real)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        GitError::from(e)
    })
}

/// The lines of a block that stay: the patterns that are not in `known` (they go in), each with the
/// comment lines right above it, and one empty line between groups. Empty when no pattern is new.
fn tidy_block(lines: &[String], known: &mut BTreeSet<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut comments: Vec<&String> = Vec::new();
    let mut blank = false;
    for l in lines {
        let t = l.trim();
        if t.is_empty() {
            comments.clear();
            blank = !out.is_empty();
        } else if t.starts_with('#') {
            comments.push(l);
        } else if known.insert(l.clone()) {
            if blank {
                out.push(String::new());
                blank = false;
            }
            out.extend(comments.drain(..).cloned());
            out.push(l.clone());
        }
    }
    out
}

/// A line of an ignore file has no line break and no NUL character.
fn check_line(line: &str) -> Result<(), GitError> {
    if line.contains(['\n', '\r', '\0']) {
        return Err(GitError::Invalid(
            "A pattern cannot contain a line break or a NUL character.".to_string(),
        ));
    }
    Ok(())
}

/// Append lines to an ignore file: a line break first when the file does not end with one, `\r\n`
/// as the line end when the file mostly uses it (`dominant_eol`). Create the file and its folder when they are missing.
fn write_lines(full: &Path, existing: &[u8], lines: &[String]) -> Result<(), GitError> {
    let eol = dominant_eol(existing);
    let mut out = String::new();
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        out.push_str(eol);
    }
    for line in lines {
        out.push_str(line);
        out.push_str(eol);
    }
    if let Some(dir) = full.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(full)?;
    file.write_all(out.as_bytes())?;
    file.flush()?;
    Ok(())
}

/// The path of an ignore file. `.git/info/exclude` comes from git, because a linked worktree
/// shares it with the main one.
fn ignore_file_path(git: &Git, repo: &RepoInfo, target: IgnoreTarget) -> Result<PathBuf, GitError> {
    let root = Path::new(&repo.path);
    match target {
        IgnoreTarget::Gitignore => Ok(root.join(".gitignore")),
        IgnoreTarget::Exclude => {
            let args = ["rev-parse", "--git-path", "info/exclude"];
            let out = git.run(root, Some(&repo.id), &args, false)?;
            let path = PathBuf::from(out.stdout.trim_end_matches(['\n', '\r']));
            Ok(if path.is_absolute() {
                path
            } else {
                root.join(path)
            })
        }
        IgnoreTarget::Global => global_ignore_path(git, repo),
    }
}

/// The global excludes file of git: `core.excludesFile` of the global config (include files followed) or
/// of the system config when it is set, else git's default (`$XDG_CONFIG_HOME/git/ignore`, or
/// `~/.config/git/ignore`). The file may not exist. DeepGit never changes the git config.
/// The folder of the repo can set its own `core.excludesFile`: see `read_ignore_file`.
pub fn global_ignore_path(git: &Git, repo: &RepoInfo) -> Result<PathBuf, GitError> {
    if let Some(path) = git.global_ignore_override() {
        return Ok(path.to_path_buf());
    }
    let configured = ["--global", "--system"].iter().find_map(|scope| {
        let args = [
            "config",
            scope,
            "--includes",
            "--path",
            "--get",
            "core.excludesFile",
        ];
        let out = git
            .run_unchecked(Path::new(&repo.path), Some(&repo.id), &args, false, None)
            .ok()?;
        let value = out.stdout.trim_end_matches(['\n', '\r']).to_string();
        (out.code == 0 && !value.trim().is_empty()).then_some(value)
    });
    resolve_global_ignore(
        configured.as_deref(),
        git.env_var("XDG_CONFIG_HOME"),
        home_dir(|k| git.env_var(k)),
    )
}

/// The home folder as git finds it: `HOME`, else `HOMEDRIVE` and `HOMEPATH` together, else `USERPROFILE`.
/// An empty value counts as not set.
fn home_dir(var: impl Fn(&str) -> Option<OsString>) -> Option<OsString> {
    let set = |k: &str| var(k).filter(|v| !v.is_empty());
    set("HOME")
        .or_else(|| {
            let (drive, path) = (set("HOMEDRIVE")?, set("HOMEPATH")?);
            let mut both = drive;
            both.push(path);
            Some(both)
        })
        .or_else(|| set("USERPROFILE"))
}

/// The rules of `global_ignore_path` on plain values: the configured path (`~` already expanded by
/// git), the `XDG_CONFIG_HOME` and the home folder.
fn resolve_global_ignore(
    configured: Option<&str>,
    xdg: Option<OsString>,
    home: Option<OsString>,
) -> Result<PathBuf, GitError> {
    if let Some(c) = configured.filter(|c| !c.trim().is_empty()) {
        // git prints `C:/Users/...` on Windows. Use the native separator so the
        // path the dialog shows looks like every other Windows path.
        let path = if cfg!(windows) {
            PathBuf::from(c.replace('/', "\\"))
        } else {
            PathBuf::from(c)
        };
        if !path.is_absolute() {
            return Err(GitError::Invalid(format!(
                "core.excludesFile is not an absolute path: {c}"
            )));
        }
        return Ok(path);
    }
    let base = match xdg.filter(|x| !x.is_empty()) {
        Some(x) => PathBuf::from(x),
        None => match home.filter(|h| !h.is_empty()) {
            Some(h) => Path::new(&h).join(".config"),
            None => {
                return Err(GitError::Invalid(
                    "Cannot find the home folder, so the global ignore file of git is unknown."
                        .to_string(),
                ))
            }
        },
    };
    Ok(base.join("git").join("ignore"))
}

/// What the messages call an ignore file.
fn ignore_label(target: IgnoreTarget, full: &Path) -> String {
    match target {
        IgnoreTarget::Gitignore => ".gitignore".to_string(),
        IgnoreTarget::Exclude => ".git/info/exclude".to_string(),
        IgnoreTarget::Global => full.display().to_string(),
    }
}

/// Make a version of some bytes: the SHA-1 in hex, a dash and the length. Use SHA-1 because its
/// output does not change between Rust releases.
fn version_of(bytes: &[u8]) -> String {
    format!("{}-{}", sha1_smol::Sha1::from(bytes).digest(), bytes.len())
}

/// Refuse an empty path, a path outside the repo and a path into the git folder (`.git`, in any
/// case). The file API must never touch that folder.
fn check_path(path: &str) -> Result<(), GitError> {
    if path.is_empty() {
        return Err(GitError::Invalid("No file path given.".to_string()));
    }
    check_rel(path)?;
    let in_git_dir = Path::new(path)
        .components()
        .any(|c| matches!(c, Component::Normal(n) if n.eq_ignore_ascii_case(".git")));
    if in_git_dir {
        return Err(GitError::Invalid(format!(
            "path inside the git folder: {path}"
        )));
    }
    Ok(())
}

/// Refuse a path that is not a regular file: a symlink, a folder, a special file or a missing file.
fn check_regular(full: &Path, path: &str) -> Result<(), GitError> {
    match std::fs::symlink_metadata(full) {
        Ok(m) if m.is_symlink() => Err(GitError::Invalid(format!("{path} is a symlink."))),
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err(GitError::Invalid(format!("not a regular file: {path}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(GitError::Invalid(format!("file not found: {path}")))
        }
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cap_keeps_the_first_paths_and_flags_the_rest() {
        let list = cap_list(set(&["a", "b", "c"]), set(&["x/", "y", "z"]), false, 2);
        assert_eq!(list.files, vec!["a", "b"]);
        assert_eq!(list.ignored, vec!["x/", "y"]);
        assert!(list.truncated);
        let all = cap_list(set(&["a", "b"]), set(&[]), false, 2);
        assert_eq!(all.files.len(), 2);
        assert!(!all.truncated);
        // A cut ignored list says so too.
        assert!(cap_list(set(&["a"]), set(&["x"]), true, 2).truncated);
    }

    fn collect(max: usize, records: &[&str]) -> (Vec<String>, bool, usize) {
        let mut c = IgnoredEntries::new(max);
        let mut read = 0;
        for r in records {
            read += 1;
            if !c.push(r) {
                break;
            }
        }
        let (kept, truncated) = c.finish();
        (kept.into_iter().collect(), truncated, read)
    }

    #[test]
    fn ignored_entries_inside_a_listed_folder_are_dropped() {
        let (kept, truncated, _) = collect(
            100,
            &[
                "out/",
                "out/deep/",
                "out/deep/a.o",
                "out/b.o",
                "x.log",
                "outer.o",
            ],
        );
        assert_eq!(kept, vec!["out/", "outer.o", "x.log"]);
        assert!(!truncated);
    }

    #[test]
    fn ignored_entries_before_their_folder_are_dropped_at_the_end() {
        let (kept, _, _) = collect(100, &["out/a.o", "out/deep/b.o", "out/", "z.o"]);
        assert_eq!(kept, vec!["out/", "z.o"]);
    }

    #[test]
    fn ignored_entries_stop_at_the_cap_and_say_so() {
        let (kept, truncated, read) = collect(2, &["a/", "a/x.o", "b.o", "c.o", "d.o"]);
        assert_eq!(kept, vec!["a/", "b.o"]);
        assert!(truncated);
        // The read stops at the first entry over the cap. Dropped entries do not count.
        assert_eq!(read, 4);
        let (_, full, _) = collect(2, &["a/", "a/x.o", "b.o"]);
        assert!(!full);
    }

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    #[test]
    fn global_ignore_follows_the_config_then_xdg_then_the_home_folder() {
        let got = |c, x, h| resolve_global_ignore(c, x, h).expect("path");
        // The configured file wins. It must be absolute on the host OS.
        let configured = if cfg!(windows) {
            "C:/etc/ign"
        } else {
            "/etc/ign"
        };
        assert_eq!(
            got(Some(configured), os("/x"), os("/h")),
            PathBuf::from(configured.replace('/', std::path::MAIN_SEPARATOR_STR))
        );
        // Without it: XDG_CONFIG_HOME, when it is set and not empty.
        assert_eq!(
            got(None, os("/x"), os("/h")),
            Path::new("/x").join("git").join("ignore")
        );
        assert_eq!(
            got(None, os(""), os("/h")),
            Path::new("/h").join(".config").join("git").join("ignore")
        );
        assert_eq!(
            got(Some(" "), None, os("/h")),
            Path::new("/h").join(".config").join("git").join("ignore")
        );
        // No home folder: an error, not a guess.
        assert!(resolve_global_ignore(None, None, None).is_err());
        assert!(resolve_global_ignore(None, os(""), os("")).is_err());
    }

    #[test]
    fn global_ignore_refuses_a_relative_configured_path() {
        let err = resolve_global_ignore(Some("rel/ignore"), None, os("/h")).unwrap_err();
        assert!(err.to_string().contains("not an absolute path"));
    }

    fn lines(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn tidy_block_drops_known_patterns_and_the_comments_left_alone() {
        let mut known: BTreeSet<String> = set(&["*.log", "dist/"]);
        let block = lines(&[
            "# Logs", "*.log", "", "# Output", "dist/", "build/", "", "# Cache", ".cache/", "*.log",
        ]);
        let kept = tidy_block(&block, &mut known);
        // "# Logs" has no pattern left. "# Output" stays for build/. Groups keep one empty line.
        assert_eq!(kept, ["# Output", "build/", "", "# Cache", ".cache/"]);
        // What went in is known now: a second block does not repeat it.
        assert!(tidy_block(&block, &mut known).is_empty());
    }

    #[test]
    fn tidy_block_is_empty_when_nothing_is_new() {
        let mut known = set(&["a"]);
        assert!(tidy_block(&lines(&["# c", "a", "", "a"]), &mut known).is_empty());
        assert!(tidy_block(&lines(&["# only a comment", ""]), &mut known).is_empty());
    }

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| {
            pairs
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| OsString::from(v))
        }
    }

    #[test]
    fn the_home_folder_follows_git_home_then_homedrive_and_homepath_then_userprofile() {
        let all = [
            ("HOME", "/h"),
            ("HOMEDRIVE", "C:"),
            ("HOMEPATH", "\\Users\\a"),
            ("USERPROFILE", "C:\\Users\\b"),
        ];
        assert_eq!(home_dir(env(&all)), os("/h"));
        // HOME empty or missing: HOMEDRIVE and HOMEPATH together.
        assert_eq!(
            home_dir(env(&[("HOME", ""), all[1], all[2], all[3]])),
            os("C:\\Users\\a")
        );
        assert_eq!(home_dir(env(&[all[1], all[2], all[3]])), os("C:\\Users\\a"));
        // One of the two alone is not a home: USERPROFILE.
        assert_eq!(home_dir(env(&[all[1], all[3]])), os("C:\\Users\\b"));
        assert_eq!(home_dir(env(&[all[2], all[3]])), os("C:\\Users\\b"));
        assert_eq!(home_dir(env(&[all[3]])), os("C:\\Users\\b"));
        assert_eq!(home_dir(env(&[])), None);
        assert_eq!(home_dir(env(&[("HOME", ""), ("USERPROFILE", "")])), None);
    }

    #[test]
    fn replace_file_refuses_a_file_that_changed_since_it_was_read_and_leaves_it_alone() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join(".gitignore");
        std::fs::write(&path, "read\n").expect("write");
        // An editor saved between the read and the write.
        std::fs::write(&path, "saved by an editor\n").expect("write");
        let err = replace_file(
            &path,
            IgnoreTarget::Gitignore,
            ".gitignore",
            b"read\n",
            b"new\n",
        )
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            ".gitignore changed while DeepGit was working. Try again."
        );
        assert_eq!(
            std::fs::read_to_string(&path).expect("file"),
            "saved by an editor\n"
        );
        // No temporary file is left behind.
        assert_eq!(std::fs::read_dir(dir.path()).expect("dir").count(), 1);
        // The same call with the right content replaces the file.
        replace_file(
            &path,
            IgnoreTarget::Gitignore,
            ".gitignore",
            b"saved by an editor\n",
            b"new\n",
        )
        .expect("replace");
        assert_eq!(std::fs::read_to_string(&path).expect("file"), "new\n");
        assert_eq!(std::fs::read_dir(dir.path()).expect("dir").count(), 1);
    }

    #[test]
    fn replace_file_leaves_the_file_whole_when_the_temporary_file_cannot_be_made() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join(".gitignore");
        std::fs::write(&path, "keep\n").expect("write");
        // A folder where the temporary file would go is not possible to predict; make the folder read-only instead.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let ro = std::fs::Permissions::from_mode(0o555);
            std::fs::set_permissions(dir.path(), ro).expect("chmod");
            let is_root = std::fs::File::create(dir.path().join("probe")).is_ok();
            let result = replace_file(
                &path,
                IgnoreTarget::Gitignore,
                ".gitignore",
                b"keep\n",
                b"new\n",
            );
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
            if !is_root {
                assert!(result.is_err());
                assert_eq!(std::fs::read_to_string(&path).expect("file"), "keep\n");
            }
        }
    }

    #[test]
    fn the_dominant_line_end_is_the_one_most_lines_use() {
        assert_eq!(dominant_eol(b""), "\n");
        assert_eq!(dominant_eol(b"a\nb\n"), "\n");
        assert_eq!(dominant_eol(b"a\r\nb\r\n"), "\r\n");
        assert_eq!(dominant_eol(b"a\r\nb\n"), "\r\n");
        assert_eq!(dominant_eol(b"a\r\nb\nc\n"), "\n");
        assert_eq!(dominant_eol(b"a\r\nb"), "\r\n");
    }

    #[test]
    fn version_changes_with_the_bytes() {
        assert_eq!(version_of(b"abc"), version_of(b"abc"));
        assert_ne!(version_of(b"abc"), version_of(b"abd"));
        assert!(version_of(b"abc").ends_with("-3"));
    }
}
