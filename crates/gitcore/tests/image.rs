mod common;

use common::*;
use gitcore::image::{self, base64_encode, image_mime};
use gitcore::DiffSpec;

fn put(r: &TestRepo, rel: &str, bytes: &[u8]) {
    std::fs::write(r.path().join(rel), bytes).unwrap();
}

fn commit_all(r: &TestRepo, msg: &str) -> String {
    r.sh(&["add", "-A"]);
    r.sh(&["commit", "-q", "-m", msg]);
    r.head()
}

fn commit_spec(oid: &str) -> DiffSpec {
    DiffSpec::Commit {
        oid: oid.to_string(),
        parent: None,
    }
}

#[test]
fn base64_matches_the_rfc_vectors() {
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");
    assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    assert_eq!(base64_encode(&[0xff, 0xfe, 0x00]), "//4A");
}

#[test]
fn mime_comes_from_the_extension() {
    assert_eq!(image_mime("a/b.PNG"), Some("image/png"));
    assert_eq!(image_mime("x.jpeg"), Some("image/jpeg"));
    assert_eq!(image_mime("x.svg"), Some("image/svg+xml"));
    assert_eq!(image_mime("x.txt"), None);
    assert_eq!(image_mime("png"), None);
}

#[test]
fn commit_sides_added_modified_deleted_and_root() {
    let r = TestRepo::new();
    let g = git();
    put(&r, "a.png", &[1, 2, 3, 4]);
    let c1 = commit_all(&r, "add");
    put(&r, "a.png", &[9, 8, 7]);
    let c2 = commit_all(&r, "change");
    std::fs::remove_file(r.path().join("a.png")).unwrap();
    let c3 = commit_all(&r, "delete");

    // Root commit: no old side.
    let added = image::file_images(&g, &r.info, &commit_spec(&c1), "a.png", None).unwrap();
    assert!(added.old.is_none());
    let new = added.new.unwrap();
    assert_eq!((new.size, new.mime.as_str()), (4, "image/png"));
    assert_eq!(
        new.data.as_deref(),
        Some(base64_encode(&[1, 2, 3, 4]).as_str())
    );
    assert!(!new.too_large);

    let changed = image::file_images(&g, &r.info, &commit_spec(&c2), "a.png", None).unwrap();
    assert_eq!(changed.old.unwrap().size, 4);
    assert_eq!(changed.new.unwrap().size, 3);

    let deleted = image::file_images(&g, &r.info, &commit_spec(&c3), "a.png", None).unwrap();
    assert_eq!(deleted.old.unwrap().size, 3);
    assert!(deleted.new.is_none());
}

#[test]
fn commit_rename_reads_the_old_side_at_the_old_path() {
    let r = TestRepo::new();
    let g = git();
    put(&r, "old.gif", &[5; 40]);
    commit_all(&r, "add");
    r.sh(&["mv", "old.gif", "new.gif"]);
    let c = commit_all(&r, "rename");
    let spec = commit_spec(&c);
    let sides = image::file_images(&g, &r.info, &spec, "new.gif", Some("old.gif")).unwrap();
    assert_eq!(sides.old.unwrap().mime, "image/gif");
    assert_eq!(sides.new.unwrap().size, 40);
    // Without the old path the old side is missing.
    assert!(image::file_images(&g, &r.info, &spec, "new.gif", None)
        .unwrap()
        .old
        .is_none());
}

#[test]
fn staged_and_unstaged_sides() {
    let r = TestRepo::new();
    let g = git();
    // An empty repo: nothing at HEAD.
    put(&r, "i.webp", &[1; 10]);
    r.sh(&["add", "i.webp"]);
    let s = image::file_images(&g, &r.info, &DiffSpec::Staged, "i.webp", None).unwrap();
    assert!(s.old.is_none());
    assert_eq!(s.new.unwrap().size, 10);
    r.sh(&["commit", "-q", "-m", "add"]);

    // Staged change: HEAD (10) -> index (20); the worktree has a third version (30).
    put(&r, "i.webp", &[2; 20]);
    r.sh(&["add", "i.webp"]);
    put(&r, "i.webp", &[3; 30]);
    let staged = image::file_images(&g, &r.info, &DiffSpec::Staged, "i.webp", None).unwrap();
    assert_eq!(
        (staged.old.unwrap().size, staged.new.unwrap().size),
        (10, 20)
    );
    let unstaged = image::file_images(&g, &r.info, &DiffSpec::Unstaged, "i.webp", None).unwrap();
    assert_eq!(
        (unstaged.old.unwrap().size, unstaged.new.unwrap().size),
        (20, 30)
    );

    // Untracked: no old side. Deleted in the worktree: no new side.
    put(&r, "u.bmp", &[7; 5]);
    let untracked = image::file_images(&g, &r.info, &DiffSpec::Unstaged, "u.bmp", None).unwrap();
    assert!(untracked.old.is_none());
    assert_eq!(untracked.new.unwrap().mime, "image/bmp");
    std::fs::remove_file(r.path().join("i.webp")).unwrap();
    let gone = image::file_images(&g, &r.info, &DiffSpec::Unstaged, "i.webp", None).unwrap();
    assert_eq!(gone.old.unwrap().size, 20);
    assert!(gone.new.is_none());
}

#[test]
fn a_side_over_the_cap_has_a_size_and_no_data() {
    let r = TestRepo::new();
    let g = git();
    let big = vec![0u8; image::MAX_IMAGE_BYTES as usize + 1];
    put(&r, "big.png", &big);
    let wt = image::file_images(&g, &r.info, &DiffSpec::Unstaged, "big.png", None).unwrap();
    let side = wt.new.unwrap();
    assert!(side.too_large && side.data.is_none());
    assert_eq!(side.size, big.len() as u64);
    let c = commit_all(&r, "big");
    let side = image::file_images(&g, &r.info, &commit_spec(&c), "big.png", None)
        .unwrap()
        .new
        .unwrap();
    assert!(side.too_large && side.data.is_none());
    assert_eq!(side.size, big.len() as u64);
}

#[test]
fn bad_paths_and_names_are_refused() {
    let r = TestRepo::new();
    let g = git();
    assert!(image::file_images(&g, &r.info, &DiffSpec::Unstaged, "../x.png", None).is_err());
    assert!(image::file_images(&g, &r.info, &DiffSpec::Unstaged, "/etc/x.png", None).is_err());
    assert!(image::file_images(&g, &r.info, &DiffSpec::Staged, "a.png", Some("../b.png")).is_err());
    assert!(image::file_images(&g, &r.info, &commit_spec("--output=x"), "a.png", None).is_err());
}

#[test]
fn the_old_unstaged_side_of_a_conflicted_image_is_ours() {
    use gitcore::{ops, MergeOpts};
    let r = TestRepo::new();
    let g = git();
    put(&r, "c.png", &[1; 4]);
    commit_all(&r, "base");
    r.sh(&["checkout", "-qb", "feature"]);
    put(&r, "c.png", &[3; 6]);
    commit_all(&r, "theirs");
    r.sh(&["checkout", "-q", "main"]);
    put(&r, "c.png", &[2; 5]);
    commit_all(&r, "ours");
    let res = ops::merge(&g, &r.info, "feature", &MergeOpts::default()).unwrap();
    assert!(res.conflicts, "{res:?}");
    // The index has no stage 0 entry. The old side is stage 2 ("ours", 5 bytes), not empty.
    let sides = image::file_images(&g, &r.info, &DiffSpec::Unstaged, "c.png", None).unwrap();
    assert_eq!(sides.old.expect("old side").size, 5);
    assert!(sides.new.is_some());
}

/// Replace the index entry of `d.png` with the given unmerged stages (`git update-index --index-info`).
fn set_stages(r: &TestRepo, stages: &[(u8, &str)]) {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut text = format!("0 {}\td.png\n", "0".repeat(40));
    for (n, id) in stages {
        text.push_str(&format!("100644 {id} {n}\td.png\n"));
    }
    let mut child = Command::new("git")
        .current_dir(r.path())
        .args(["update-index", "--index-info"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
}

#[test]
fn the_old_unstaged_side_of_a_conflict_falls_back_to_theirs_then_head() {
    let r = TestRepo::new();
    let g = git();
    put(&r, "d.png", &[1; 4]);
    commit_all(&r, "base");
    let base = r.sh(&["rev-parse", "HEAD:d.png"]);
    put(&r, "theirs.tmp", &[3; 7]);
    let theirs = r.sh(&["hash-object", "-w", "theirs.tmp"]);
    let old_size = || {
        image::file_images(&g, &r.info, &DiffSpec::Unstaged, "d.png", None)
            .unwrap()
            .old
            .map(|s| s.size)
    };
    // Ours deleted the file: stages 1 and 3 only. The old side is theirs.
    set_stages(&r, &[(1, &base), (3, &theirs)]);
    assert_eq!(old_size(), Some(7));
    // Both deleted it: stage 1 only. The old side is HEAD.
    set_stages(&r, &[(1, &base)]);
    assert_eq!(old_size(), Some(4));
    // No entry at all and no conflict (git rm --cached): no old side, not HEAD.
    r.sh(&["update-index", "--force-remove", "d.png"]);
    assert_eq!(old_size(), None);
}
