//! File watcher: turns file system activity inside a repository into debounced `repo-changed`
//! notifications. The module has no Tauri dependency; the app passes an `emit` callback.
//!
//! The OS events come straight from `notify` and are debounced here (not by a debouncer crate):
//! a crate that drops events without a path would also drop the "queue overflow, rescan" notice,
//! and with it the only sign that changes were missed. Such a notice, and any watcher error,
//! makes every repository refresh and its watch set be rebuilt.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

use gitcore::RepoInfo;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

const DEBOUNCE: Duration = Duration::from_millis(400);

/// Longest a `git` question about ignored folders may take; past it the folders stay skipped.
const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// A rescan (overflow, watcher error) rebuilds the watch set and refreshes the repo at most this
/// often per repo; one that comes sooner is postponed to the end of the gap, never dropped.
const RESCAN_GAP: Duration = Duration::from_secs(5);

/// The skipped folders are checked for newly tracked files (an index change) at most this often.
const INDEX_RECHECK_GAP: Duration = Duration::from_secs(2);

/// Most directory watches a single repository may hold. Past this, no more are added (inotify
/// has a per-user limit); git-dir events keep the app refreshing.
const MAX_DIR_WATCHES: usize = 20_000;

/// Files directly inside `.git` that mean "the repository changed".
const GIT_FILES: [&str; 7] = [
    "HEAD",
    "index",
    "packed-refs",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "FETCH_HEAD",
];
/// Directories inside `.git` whose whole subtree is relevant.
const GIT_DIRS: [&str; 3] = ["refs", "rebase-merge", "rebase-apply"];
/// Directories inside `.git` that only exist while a rebase runs; watched once they appear.
const REBASE_DIRS: [&str; 2] = ["rebase-merge", "rebase-apply"];

/// Names of build output, dependency and tooling directories: huge and noisy. A directory with
/// one of these names is skipped (not watched, its events dropped) only when git ignores it and
/// holds no tracked file; otherwise it is watched like any other folder (see [`classify`]).
/// Only these names cost a question to git, every other folder is watched at once.
const NOISY_DIRS: [&str; 12] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    ".gradle",
    ".idea",
    "__pycache__",
    ".next",
    ".cache",
];

/// Called with a repo id once per repo per debounce batch.
pub type Emit = Arc<dyn Fn(&str) + Send + Sync>;

/// For the tests: every path that made the watcher emit, so a failed assertion can say which
/// file system event was behind a notification.
#[cfg(test)]
static EMIT_CAUSES: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Whether `name` is the name of a directory that may be skipped.
fn is_noisy_name(name: &OsStr) -> bool {
    NOISY_DIRS.contains(&name.to_string_lossy().as_ref())
}

// ---------------------------------------------------------------- asking git

/// Runs `git -C root args` and returns its exit code and stdout; `None` when git cannot be run
/// or does not finish within `timeout` (it is killed then). Never called with a lock held.
fn run_git(
    root: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Option<(i32, Vec<u8>)> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        // Its own process group, so a timeout takes git's children down with it.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().ok()?;
    let writer = stdin.map(|data| {
        let mut pipe = child.stdin.take();
        let data = data.to_vec();
        std::thread::spawn(move || {
            if let Some(p) = pipe.as_mut() {
                let _ = p.write_all(&data);
            }
        })
    });
    let reader = child.stdout.take().map(|mut p| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut p, &mut buf);
            buf
        })
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                kill_tree(&mut child);
                let _ = child.wait();
                break None;
            }
        }
    };
    // Timed out: the helper threads are left to end on their own (a grandchild of git may still
    // hold the pipes open for a while).
    let status = status?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    let out = reader.and_then(|r| r.join().ok()).unwrap_or_default();
    Some((status.code()?, out))
}

/// Kills git and what it started (a filter, a hook, a credential helper), like gitcore's runner:
/// `taskkill /T` on Windows, a `kill` of the process group (see `run_git`) elsewhere.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-s", "KILL", "--", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// Name of a file that does not exist: git is asked whether it would be ignored, which tells
/// whether the whole folder is (a folder with its own `.gitignore` of `*` is not itself matched).
const PROBE: &str = ".deepgit-watch-probe";

/// Folders asked about in one `git ls-files` call (the paths are arguments).
const LS_FILES_BATCH: usize = 200;

/// Slash-separated path of `dir` relative to `root`.
fn slashed(root: &Path, dir: &Path) -> Option<String> {
    let rel = dir.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// Whether the path `file`, as git lists it, lies below the folder `spec` (slash-terminated, as
/// named on disk). Windows and macOS file systems ignore case, and git lists the case it has
/// in the index, which may differ from the folder's name on disk.
fn below(file: &str, spec: &str) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        file.to_lowercase().starts_with(&spec.to_lowercase())
    } else {
        file.starts_with(spec)
    }
}

fn nul_list(out: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(out)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

/// For each folder of `rels` (slash-separated, relative to `root`), whether `git ls-files
/// <flags>` lists a file below it. `None` when git cannot answer.
fn listed_below(root: &Path, rels: &[String], flags: &[&str]) -> Option<Vec<bool>> {
    let mut out = Vec::with_capacity(rels.len());
    for batch in rels.chunks(LS_FILES_BATCH) {
        let specs: Vec<String> = batch.iter().map(|r| format!("{r}/")).collect();
        let mut args = vec!["--literal-pathspecs", "ls-files", "-z"];
        args.extend_from_slice(flags);
        args.push("--");
        args.extend(specs.iter().map(String::as_str));
        let (code, stdout) = run_git(root, &args, None, GIT_TIMEOUT)?;
        if code != 0 {
            return None;
        }
        let files = nul_list(&stdout);
        out.extend(specs.iter().map(|s| files.iter().any(|f| below(f, s))));
    }
    Some(out)
}

/// Decides, for folders named like an entry of [`NOISY_DIRS`] (inside `root`), which are watched
/// and which skipped, as `(watch, skip)`.
///
/// A folder that git does not ignore is watched. For one that does (one `git check-ignore` call
/// for all of them, on a probe file inside) the probe alone proves nothing, because a pattern
/// like `.*` or `dist/*` can hide the probe and still leave real files visible (`!dist/keep.txt`,
/// a new `build/main.c` under `.*` + `!.gitignore`). So it is skipped only when git shows
/// nothing below it: one `git ls-files --cached --others --exclude-standard` call per batch lists
/// the tracked files (`git add -f dist/x`) and the untracked files that are not ignored.
/// When git cannot answer (not a repository, no git, too slow) the folders are skipped, the way
/// they always were.
fn classify(root: &Path, dirs: &[PathBuf]) -> (Vec<PathBuf>, Vec<PathBuf>) {
    if dirs.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let mut rels = Vec::with_capacity(dirs.len());
    let mut input = String::new();
    for d in dirs {
        let Some(rel) = slashed(root, d) else {
            return (Vec::new(), dirs.to_vec());
        };
        input.push_str(&format!("{rel}/{PROBE}\0"));
        rels.push(rel);
    }
    // Exit 1 means "none of them is ignored".
    let Some((code, out)) = run_git(
        root,
        &["check-ignore", "-z", "--stdin"],
        Some(input.as_bytes()),
        GIT_TIMEOUT,
    )
    .filter(|(c, _)| *c == 0 || *c == 1) else {
        return (Vec::new(), dirs.to_vec());
    };
    let ignored: HashSet<String> = if code == 0 {
        nul_list(&out).into_iter().collect()
    } else {
        HashSet::new()
    };
    let (mut watch, mut maybe_skip, mut maybe_rels) = (Vec::new(), Vec::new(), Vec::new());
    for (d, rel) in dirs.iter().zip(rels) {
        if ignored.contains(&format!("{rel}/{PROBE}")) {
            maybe_skip.push(d);
            maybe_rels.push(rel);
        } else {
            watch.push(d.clone());
        }
    }
    let shown = listed_below(
        root,
        &maybe_rels,
        &[
            "--cached",
            "--others",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
        ],
    );
    let mut skip = Vec::new();
    for (i, d) in maybe_skip.into_iter().enumerate() {
        match &shown {
            Some(v) if v[i] => watch.push(d.clone()),
            _ => skip.push(d.clone()),
        }
    }
    (watch, skip)
}

// ---------------------------------------------------------------- what counts

/// Whether `path` lies in, or is, one of the `skipped` folders.
fn under_skipped(path: &Path, skipped: &HashSet<PathBuf>) -> bool {
    !skipped.is_empty() && path.ancestors().any(|a| skipped.contains(a))
}

/// Whether a change at `path` should refresh the repository rooted at `repo_root`.
/// Everything in the worktree counts, except inside the folders the watcher decided to skip
/// (`skipped`, see [`classify`]: ignored by git and without tracked files; decided by path, so a
/// tracked file that happens to be named `build` is not affected); inside `.git` only the state
/// files listed above do, and lock files never do.
pub fn relevant(path: &Path, repo_root: &Path, skipped: &HashSet<PathBuf>) -> bool {
    let Ok(rel) = path.strip_prefix(repo_root) else {
        return false;
    };
    let comps: Vec<&OsStr> = rel.components().map(|c| c.as_os_str()).collect();
    let Some(first) = comps.first() else {
        return false; // the root itself
    };
    if *first != ".git" {
        return !under_skipped(path, skipped);
    }
    git_internal_relevant(&comps[1..])
}

/// Like the `.git` branch of [`relevant`], for a git dir that lives outside the worktree
/// (linked worktrees and submodules point at one through a `.git` file).
pub fn git_dir_relevant(path: &Path, git_dir: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(git_dir) else {
        return false;
    };
    let comps: Vec<&OsStr> = rel.components().map(|c| c.as_os_str()).collect();
    git_internal_relevant(&comps)
}

/// `rest` is the path inside the git dir.
fn git_internal_relevant(rest: &[&OsStr]) -> bool {
    let Some(last) = rest.last() else {
        return false; // the git dir itself
    };
    if last.to_string_lossy().ends_with(".lock") {
        return false;
    }
    let top = rest[0].to_string_lossy();
    if rest.len() == 1 {
        GIT_FILES.contains(&top.as_ref()) || GIT_DIRS.contains(&top.as_ref())
    } else {
        // `info/exclude` decides which files are untracked.
        GIT_DIRS.contains(&top.as_ref()) || is_exclude_file(rest)
    }
}

fn is_exclude_file(rest: &[&OsStr]) -> bool {
    matches!(rest, [info, exclude] if *info == "info" && *exclude == "exclude")
}

/// Whether a change at `path` can change which folders git ignores: a `.gitignore` anywhere in
/// the worktree, or `info/exclude` of the git dir.
fn changes_ignore_rules(path: &Path, git_dir: Option<&Path>) -> bool {
    if path.file_name().is_some_and(|n| n == ".gitignore") {
        return true;
    }
    git_dir
        .and_then(|g| path.strip_prefix(g).ok())
        .is_some_and(|rest| {
            let comps: Vec<&OsStr> = rest.components().map(|c| c.as_os_str()).collect();
            is_exclude_file(&comps)
        })
}

/// The deepest repo root that contains `path`, as `(root, repo_id)`.
pub fn owner<'a>(path: &Path, roots: &'a [(PathBuf, String)]) -> Option<&'a (PathBuf, String)> {
    roots
        .iter()
        .filter(|(root, _)| path.starts_with(root))
        .max_by_key(|(root, _)| root.components().count())
}

/// The real git dir of the repo at `root`: `.git` itself, or the target of a `gitdir:` pointer
/// file (linked worktrees, submodules).
pub fn resolve_git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    let meta = std::fs::metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return Some(dot_git);
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:"))?
        .trim();
    let target = root.join(target); // an absolute `target` replaces `root`
    target.is_dir().then_some(target)
}

// ---------------------------------------------------------------- the watch set

/// Directories to watch (non-recursively) in a worktree, breadth first, starting at `start`
/// itself. `.git` and nested repositories (a subdirectory with its own `.git`) are skipped, and
/// symlinks are not followed. A directory named like an entry of [`NOISY_DIRS`] is entered only
/// when `decide` (asked once per round with all the candidates found) returns it. At most
/// `limit` directories are returned; the flag says whether more were left out.
fn walk_dirs(
    start: &Path,
    limit: usize,
    decide: &mut dyn FnMut(&[PathBuf]) -> Vec<PathBuf>,
) -> (Vec<PathBuf>, bool) {
    let mut out = Vec::new();
    let mut queue = VecDeque::from([start.to_path_buf()]);
    let mut candidates: Vec<PathBuf> = Vec::new();
    loop {
        let Some(dir) = queue.pop_front() else {
            if candidates.is_empty() {
                break;
            }
            queue.extend(decide(&std::mem::take(&mut candidates)));
            continue;
        };
        if out.len() >= limit {
            return (out, true);
        }
        out.push(dir.clone());
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            // `DirEntry::file_type` does not follow symlinks.
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name();
            if name == ".git" {
                continue;
            }
            let path = entry.path();
            if path.join(".git").exists() {
                continue;
            }
            if is_noisy_name(&name) {
                candidates.push(path);
            } else {
                queue.push_back(path);
            }
        }
    }
    (out, false)
}

/// Whether `path` is a directory inside the worktree of `root` that may be watched, leaving
/// aside the decision about folders named like an entry of [`NOISY_DIRS`].
fn is_watchable_dir(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    if rel.as_os_str().is_empty() || rel.components().any(|c| c.as_os_str() == ".git") {
        return false;
    }
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) && !path.join(".git").exists()
}

/// Identity of a directory, to tell one that was removed and created again from the one the OS
/// watch was set on (the watch dies with the old directory). The inode alone is not enough: a
/// file system hands the number of a removed directory to the next one it creates. The creation
/// time (0 when the system does not report one) tells them apart.
type DirId = (u64, u64, u64);

fn dir_id(path: &Path) -> Option<DirId> {
    let m = std::fs::symlink_metadata(path).ok()?;
    let born = m
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as u64);
    #[cfg(unix)]
    let (dev, ino) = {
        use std::os::unix::fs::MetadataExt;
        (m.dev(), m.ino())
    };
    #[cfg(not(unix))]
    let (dev, ino) = (0, 0);
    Some((dev, ino, born))
}

/// What is watched for one repository.
struct RepoWatch {
    /// The real git dir, when it could be found.
    git_dir: Option<PathBuf>,
    /// Every path with an OS watch (recursive ones count as one).
    dirs: HashSet<PathBuf>,
    /// The identity of each watched worktree directory when its watch was set.
    ids: HashMap<PathBuf, DirId>,
    /// Folders named like a noisy one that git ignores and that hold no tracked file: not
    /// watched, and what happens inside them is not a change.
    skipped: HashSet<PathBuf>,
    /// The watch cap was reached (or the OS ran out of watches); warned about already.
    capped: bool,
}

impl RepoWatch {
    /// Watches each of `dirs`; stops (and warns once) if `truncated` or the OS runs out.
    fn add(&mut self, w: &mut dyn Watcher, root: &Path, dirs: Vec<PathBuf>, mut truncated: bool) {
        for dir in dirs {
            if self.dirs.contains(&dir) {
                continue;
            }
            if self.dirs.len() >= MAX_DIR_WATCHES {
                truncated = true;
                break;
            }
            match w.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    if let Some(id) = dir_id(&dir) {
                        self.ids.insert(dir.clone(), id);
                    }
                    self.dirs.insert(dir);
                }
                Err(e) if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) => {
                    truncated = true;
                    break;
                }
                // Vanished or unreadable directory: not worth a log line.
                Err(_) => {}
            }
        }
        if truncated && !self.capped {
            self.capped = true;
            tracing::warn!(
                "watch limit reached for {}: not watching more directories there",
                root.display()
            );
        }
    }

    /// Drops `path` and every watch below it. The OS watches of folders that are gone died with
    /// them; the unwatch of those fails and that is fine.
    fn forget(&mut self, w: &mut dyn Watcher, path: &Path) {
        for d in self.dirs.iter().filter(|d| d.starts_with(path)) {
            let _ = w.unwatch(d);
        }
        self.dirs.retain(|d| !d.starts_with(path));
        self.ids.retain(|d, _| !d.starts_with(path));
    }

    /// [`RepoWatch::forget`] for a folder that is gone or was replaced: the skipped folders below
    /// it go too (a new one is decided again).
    fn forget_gone(&mut self, w: &mut dyn Watcher, path: &Path) {
        self.forget(w, path);
        self.skipped.retain(|s| !s.starts_with(path));
    }

    /// Watches `<git dir>/info` (where `exclude` is) when it exists and is not watched yet.
    /// Returns whether it was added now. Linked worktrees keep `info/exclude` in the main
    /// repository's git dir (`commondir`); that one is not watched, it is not worth the
    /// bookkeeping of which worktree it belongs to.
    fn watch_info(&mut self, w: &mut dyn Watcher) -> bool {
        let Some(info) = self.git_dir.as_ref().map(|g| g.join("info")) else {
            return false;
        };
        if self.dirs.contains(&info) || !info.is_dir() {
            return false;
        }
        if w.watch(&info, RecursiveMode::NonRecursive).is_ok() {
            self.dirs.insert(info);
            return true;
        }
        false
    }

    fn add_recursive(&mut self, w: &mut dyn Watcher, dir: PathBuf) {
        if !self.dirs.contains(&dir) && w.watch(&dir, RecursiveMode::Recursive).is_ok() {
            self.dirs.insert(dir);
        }
    }

    /// A watched directory of the worktree (not the git dir, not the root).
    fn is_worktree_dir(&self, root: &Path, dir: &Path) -> bool {
        dir != root
            && dir.starts_with(root)
            && !self.git_dir.as_deref().is_some_and(|g| dir.starts_with(g))
            && !dir.starts_with(root.join(".git"))
    }
}

/// The watches of a repo worked out without any lock held (it asks git), applied afterwards.
struct RepoPlan {
    git_dir: Option<PathBuf>,
    dirs: Vec<PathBuf>,
    truncated: bool,
    skipped: HashSet<PathBuf>,
}

/// Walks the whole worktree of `root` and decides about its noisy folders.
fn plan_repo(root: &Path) -> RepoPlan {
    let mut skipped = HashSet::new();
    let (dirs, truncated) = walk_dirs(root, MAX_DIR_WATCHES, &mut |c| {
        let (watch, skip) = classify(root, c);
        skipped.extend(skip);
        watch
    });
    RepoPlan {
        git_dir: resolve_git_dir(root),
        dirs,
        truncated,
        skipped,
    }
}

/// A new or changed directory whose subtree may need watches (asked about with no lock held).
struct WalkReq {
    root: PathBuf,
    path: PathBuf,
    /// Noisy folders on the way to `path` that are neither watched nor decided yet.
    undecided: Vec<PathBuf>,
    limit: usize,
}

struct WalkPlan {
    /// A folder on the way is skipped: nothing is watched.
    blocked: bool,
    dirs: Vec<PathBuf>,
    truncated: bool,
    skipped: Vec<PathBuf>,
}

fn plan_walk(req: &WalkReq) -> WalkPlan {
    let mut skipped = Vec::new();
    if !req.undecided.is_empty() {
        let (_, skip) = classify(&req.root, &req.undecided);
        if !skip.is_empty() {
            skipped.extend(skip);
            return WalkPlan {
                blocked: true,
                dirs: Vec::new(),
                truncated: false,
                skipped,
            };
        }
    }
    let (dirs, truncated) = walk_dirs(&req.path, req.limit, &mut |c| {
        let (watch, skip) = classify(&req.root, c);
        skipped.extend(skip);
        watch
    });
    WalkPlan {
        blocked: false,
        dirs,
        truncated,
        skipped,
    }
}

/// State shared between [`WatcherHandle`] and the thread that handles the events.
struct Inner {
    watcher: Option<RecommendedWatcher>,
    /// Active watches, by repo root.
    repos: HashMap<PathBuf, RepoWatch>,
    /// Throttled work that is waiting, by repo root.
    due: HashMap<PathBuf, Due>,
    /// Repos whose ignore rules changed on their own (`.git/info` appeared with an `exclude`).
    rules_dirty: HashSet<PathBuf>,
}

/// Work that runs at most once per gap for a repo; a request inside the gap waits for its end.
#[derive(Default)]
struct Due {
    rescan_pending: bool,
    rescan_last: Option<Instant>,
    index_pending: bool,
    index_last: Option<Instant>,
}

impl Inner {
    /// Sets up the watches of a repo that was just added, from a plan made without the lock.
    fn apply_setup(&mut self, root: &Path, plan: RepoPlan) {
        let Some(w) = self.watcher.as_mut().map(|w| w as &mut dyn Watcher) else {
            return;
        };
        let mut rw = RepoWatch {
            git_dir: plan.git_dir,
            dirs: HashSet::new(),
            ids: HashMap::new(),
            skipped: plan.skipped,
            capped: false,
        };
        if let Some(git_dir) = rw.git_dir.clone() {
            // The git dir itself catches HEAD/index/... and the creation of the rebase dirs.
            if w.watch(&git_dir, RecursiveMode::NonRecursive).is_ok() {
                rw.dirs.insert(git_dir.clone());
            }
            // `info/exclude` changes what is untracked.
            rw.watch_info(w);
            for sub in GIT_DIRS {
                let dir = git_dir.join(sub);
                if dir.is_dir() {
                    rw.add_recursive(w, dir);
                }
            }
        }
        rw.add(w, root, plan.dirs, plan.truncated);
        self.repos.insert(root.to_path_buf(), rw);
    }

    /// Brings the watches of a repo in line with a fresh plan: ignore rules may have changed
    /// (newly skipped folders are dropped, newly admitted ones watched), events may have been
    /// lost (folders created or removed meanwhile, directories replaced by new ones).
    fn apply_resync(&mut self, root: &Path, plan: RepoPlan) {
        let (Some(rw), Some(w)) = (
            self.repos.get_mut(root),
            self.watcher.as_mut().map(|w| w as &mut dyn Watcher),
        ) else {
            return;
        };
        rw.skipped = plan.skipped;
        rw.watch_info(w);
        let skipped: Vec<PathBuf> = rw.skipped.iter().cloned().collect();
        for s in &skipped {
            rw.forget(w, s);
        }
        let gone: Vec<PathBuf> = rw
            .dirs
            .iter()
            .filter(|d| rw.is_worktree_dir(root, d) && !d.is_dir())
            .cloned()
            .collect();
        for d in gone {
            rw.forget(w, &d);
        }
        for d in &plan.dirs {
            if rw.dirs.contains(d)
                && rw.is_worktree_dir(root, d)
                && rw.ids.get(d) != dir_id(d).as_ref()
            {
                rw.forget(w, d);
            }
        }
        rw.add(w, root, plan.dirs, plan.truncated);
    }

    fn teardown(&mut self, root: &Path) {
        self.due.remove(root);
        let (Some(rw), Some(w)) = (self.repos.remove(root), self.watcher.as_mut()) else {
            return;
        };
        for dir in rw.dirs {
            // The folder may be gone already; nothing useful to do on failure.
            let _ = w.unwatch(&dir);
        }
    }

    /// The repo whose out-of-worktree git dir contains `path`, as `(root, git_dir)`.
    fn external_git_owner(&self, path: &Path) -> Option<(&Path, &Path)> {
        self.repos.iter().find_map(|(root, rw)| {
            let git_dir = rw.git_dir.as_deref()?;
            (!git_dir.starts_with(root) && path.starts_with(git_dir))
                .then_some((root.as_path(), git_dir))
        })
    }

    fn skipped_of(&self, root: &Path) -> HashSet<PathBuf> {
        self.repos
            .get(root)
            .map(|rw| rw.skipped.clone())
            .unwrap_or_default()
    }

    /// Keeps the watches of `root` in line with a change at `path`: vanished directories are
    /// forgotten, rebase state dirs and a directory that was removed and created again (a
    /// checkout does that) get a fresh watch. Returns what has to be walked for the new
    /// subtree, which the caller asks git about with no lock held.
    fn prepare(&mut self, root: &Path, path: &Path) -> Option<WalkReq> {
        let (Some(rw), Some(w)) = (
            self.repos.get_mut(root),
            self.watcher.as_mut().map(|w| w as &mut dyn Watcher),
        ) else {
            return None;
        };
        let is_dir = std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir());
        if !is_dir {
            // A folder that is gone is no longer skipped (a new one is decided again).
            rw.skipped.remove(path);
        }
        if rw.dirs.contains(path) {
            if !path.exists() {
                // notify drops the OS watch itself; forget it and everything below it.
                rw.forget_gone(w, path);
                return None;
            }
            // Same directory: nothing to do. A new one at the same path has no watch yet.
            if !rw.is_worktree_dir(root, path) || rw.ids.get(path) == dir_id(path).as_ref() {
                return None;
            }
            rw.forget_gone(w, path);
        } else if !is_dir {
            return None;
        }
        if let Some(git_dir) = rw.git_dir.clone() {
            if let Ok(rel) = path.strip_prefix(&git_dir) {
                let mut comps = rel.components();
                if let (Some(top), None) = (comps.next(), comps.next()) {
                    let top = top.as_os_str().to_string_lossy();
                    if REBASE_DIRS.contains(&top.as_ref()) {
                        rw.add_recursive(w, path.to_path_buf());
                    } else if top == "info" && rw.watch_info(w) && path.join("exclude").exists() {
                        // Created after the setup, with rules in it already.
                        self.rules_dirty.insert(root.to_path_buf());
                    }
                }
                return None;
            }
        }
        if !is_watchable_dir(path, root) {
            return None;
        }
        // Every folder on the way named like a noisy one must be watched already or be one
        // git does not ignore.
        let rel = path.strip_prefix(root).ok()?;
        let mut undecided = Vec::new();
        let mut prefix = root.to_path_buf();
        for c in rel.components() {
            prefix.push(c);
            if is_noisy_name(c.as_os_str()) {
                if rw.skipped.contains(&prefix) {
                    return None;
                }
                if !rw.dirs.contains(&prefix) {
                    undecided.push(prefix.clone());
                }
            }
        }
        Some(WalkReq {
            root: root.to_path_buf(),
            path: path.to_path_buf(),
            undecided,
            limit: MAX_DIR_WATCHES.saturating_sub(rw.dirs.len()),
        })
    }

    fn apply_walk(&mut self, root: &Path, plan: WalkPlan) {
        let (Some(rw), Some(w)) = (
            self.repos.get_mut(root),
            self.watcher.as_mut().map(|w| w as &mut dyn Watcher),
        ) else {
            return;
        };
        rw.skipped.extend(plan.skipped);
        if !plan.blocked {
            rw.add(w, root, plan.dirs, plan.truncated);
        }
    }
}

fn lock(inner: &Mutex<Inner>) -> std::sync::MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------- events

/// What one notify callback means for the debouncer.
#[derive(Debug, PartialEq, Eq)]
enum Incoming {
    Paths(Vec<PathBuf>),
    /// Events were (or may have been) lost: every repository is read again.
    Rescan,
    Nothing,
}

/// A watcher error, a rescan flag (inotify queue overflow) or an event that names no path all
/// mean that changes may have been missed. A path-less access event is noise.
fn classify_event(res: &notify::Result<Event>) -> Incoming {
    match res {
        Err(e) => {
            tracing::warn!("file watcher error: {e}");
            Incoming::Rescan
        }
        Ok(ev) if ev.need_rescan() => Incoming::Rescan,
        Ok(ev) if ev.paths.is_empty() => {
            if matches!(ev.kind, EventKind::Access(_)) {
                Incoming::Nothing
            } else {
                Incoming::Rescan
            }
        }
        Ok(ev) => Incoming::Paths(ev.paths.clone()),
    }
}

/// Events collected until the debounce time has passed.
#[derive(Default)]
struct Pending {
    paths: HashSet<PathBuf>,
    rescan: bool,
    /// When the first event of the batch arrived.
    since: Option<Instant>,
}

impl Pending {
    fn add(&mut self, incoming: Incoming, now: Instant) {
        match incoming {
            Incoming::Nothing => return,
            Incoming::Rescan => self.rescan = true,
            Incoming::Paths(p) => self.paths.extend(p),
        }
        self.since.get_or_insert(now);
    }
}

/// The earlier of two optional instants.
fn soonest(a: Option<Instant>, b: Option<Instant>) -> Option<Instant> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, y) => x.or(y),
    }
}

/// The thread that debounces the notify events: one batch per `DEBOUNCE` after the first event.
/// It also wakes up for the work that was postponed (a rescan, a check of the skipped folders).
///
/// Windows (ReadDirectoryChangesW) reports a full buffer as an error, which is a rescan like the
/// others; notify 6 has no overflow signal there, so only the focus refresh of the app covers that.
fn event_loop(
    rx: mpsc::Receiver<notify::Result<Event>>,
    shared: Weak<Mutex<Inner>>,
    roots: Arc<RwLock<Vec<(PathBuf, String)>>>,
    emit: Emit,
) {
    let mut pending = Pending::default();
    let mut wake: Option<Instant> = None;
    loop {
        let next = soonest(pending.since.map(|t| t + DEBOUNCE), wake);
        let got = match next {
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(t) => rx.recv_timeout(t.saturating_duration_since(Instant::now())),
        };
        match got {
            Ok(res) => {
                pending.add(classify_event(&res), Instant::now());
                // A burst of events is read at once.
                while let Ok(res) = rx.try_recv() {
                    pending.add(classify_event(&res), Instant::now());
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let now = Instant::now();
        let batch_due = pending.since.is_some_and(|t| now >= t + DEBOUNCE);
        let wake_due = wake.is_some_and(|t| now >= t);
        if !batch_due && !wake_due {
            continue;
        }
        let roots_now = roots.read().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(shared) = shared.upgrade() else {
            return;
        };
        let out = if batch_due {
            process(&std::mem::take(&mut pending), &shared, &roots_now)
        } else {
            run_due(&shared, &roots_now, now)
        };
        wake = out.wake;
        for id in &out.ids {
            emit(id);
        }
    }
}

/// What a batch (or a wake-up) concluded.
#[derive(Debug, Default)]
struct Outcome {
    /// Repos to tell the app about.
    ids: Vec<String>,
    /// When postponed work comes due, if any is waiting.
    wake: Option<Instant>,
}

/// Runs the postponed work that is due: rescans (refresh and rebuild the watch set, once per
/// `RESCAN_GAP` per repo) and the check of the skipped folders after an index change (once per
/// `INDEX_RECHECK_GAP`). What is not due yet stays pending and sets `wake`.
fn run_due(shared: &Mutex<Inner>, roots: &[(PathBuf, String)], now: Instant) -> Outcome {
    let mut out = Outcome::default();
    let (mut rescans, mut index_checks) = (Vec::new(), Vec::new());
    {
        let mut g = lock(shared);
        for (root, id) in roots {
            let Some(d) = g.due.get_mut(root) else {
                continue;
            };
            if d.rescan_pending {
                match d.rescan_last.map(|t| t + RESCAN_GAP) {
                    Some(at) if now < at => out.wake = soonest(out.wake, Some(at)),
                    _ => {
                        d.rescan_pending = false;
                        d.rescan_last = Some(now);
                        rescans.push((root.clone(), id.clone()));
                    }
                }
            }
            if d.index_pending {
                match d.index_last.map(|t| t + INDEX_RECHECK_GAP) {
                    Some(at) if now < at => out.wake = soonest(out.wake, Some(at)),
                    _ => {
                        d.index_pending = false;
                        d.index_last = Some(now);
                        index_checks.push(root.clone());
                    }
                }
            }
        }
    }
    for (root, id) in &rescans {
        out.ids.push(id.clone());
        let watched = lock(shared).repos.contains_key(root);
        if watched {
            let plan = plan_repo(root);
            lock(shared).apply_resync(root, plan);
        }
    }
    // A rescan has looked at every folder already.
    for root in index_checks
        .iter()
        .filter(|r| !rescans.iter().any(|(x, _)| x == *r))
    {
        recheck_skipped(shared, root);
    }
    out
}

/// A tracked file may have appeared in a skipped folder (`git add -f`, a checkout): those
/// folders are watched from now on.
fn recheck_skipped(shared: &Mutex<Inner>, root: &Path) {
    let dirs: Vec<PathBuf> = match lock(shared).repos.get(root) {
        Some(rw) => rw.skipped.iter().cloned().collect(),
        None => return,
    };
    let rels: Vec<String> = dirs.iter().filter_map(|d| slashed(root, d)).collect();
    if rels.len() != dirs.len() {
        return;
    }
    let Some(tracked) = listed_below(root, &rels, &["--cached"]) else {
        return;
    };
    for dir in dirs
        .into_iter()
        .zip(tracked)
        .filter_map(|(d, t)| t.then_some(d))
    {
        let limit = {
            let mut g = lock(shared);
            let Some(rw) = g.repos.get_mut(root) else {
                return;
            };
            if !rw.skipped.remove(&dir) {
                continue;
            }
            MAX_DIR_WATCHES.saturating_sub(rw.dirs.len())
        };
        let plan = plan_walk(&WalkReq {
            root: root.to_path_buf(),
            path: dir,
            undecided: Vec::new(),
            limit,
        });
        lock(shared).apply_walk(root, plan);
    }
}

/// Works out which repos a batch concerns (keeping their watches in line on the way) and
/// returns their ids. git is only asked with no lock held. A rescan is not done here: it is
/// marked pending, and `run_due` runs it unless one ran lately, in which case it waits for the
/// end of the gap (so the folders made while events were lost do get their watches).
fn process(batch: &Pending, shared: &Mutex<Inner>, roots: &[(PathBuf, String)]) -> Outcome {
    let mut ids: Vec<String> = Vec::new();
    let mut resync: HashSet<PathBuf> = HashSet::new();
    if batch.rescan {
        let mut g = lock(shared);
        for (root, _) in roots {
            g.due.entry(root.clone()).or_default().rescan_pending = true;
        }
    }
    for path in &batch.paths {
        let path = path.as_path();
        let mut g = lock(shared);
        // A linked worktree's git dir lives outside its root: check it first.
        let external = g
            .external_git_owner(path)
            .map(|(r, gd)| (r.to_path_buf(), gd.to_path_buf()));
        let hit = match external {
            Some((root, git_dir)) => roots
                .iter()
                .find(|(r, _)| *r == root)
                .map(|(_, id)| (root, id, Some(git_dir))),
            None => owner(path, roots).map(|(root, id)| (root.clone(), id, None)),
        };
        let Some((root, id, ext_git_dir)) = hit else {
            continue;
        };
        let before = g.skipped_of(&root);
        let git_dir = ext_git_dir
            .clone()
            .or_else(|| g.repos.get(&root).and_then(|rw| rw.git_dir.clone()));
        let is_rule_change =
            changes_ignore_rules(path, git_dir.as_deref()) && !under_skipped(path, &before);
        if !before.is_empty() && git_dir.as_deref().is_some_and(|g| path == g.join("index")) {
            // New tracked files under a skipped folder make it worth watching.
            g.due.entry(root.clone()).or_default().index_pending = true;
        }
        let req = g.prepare(&root, path);
        drop(g);
        if let Some(req) = req {
            let plan = plan_walk(&req);
            lock(shared).apply_walk(&root, plan);
        }
        let after = {
            let mut g = lock(shared);
            if g.rules_dirty.remove(&root) {
                resync.insert(root.clone());
            }
            g.skipped_of(&root)
        };
        if is_rule_change {
            resync.insert(root.clone());
        }
        let relevant = match &ext_git_dir {
            Some(git_dir) => git_dir_relevant(path, git_dir),
            None => relevant(path, &root, &before) && relevant(path, &root, &after),
        };
        #[cfg(test)]
        if relevant {
            let mut causes = EMIT_CAUSES.lock().unwrap_or_else(|e| e.into_inner());
            causes.push(path.to_path_buf());
        }
        if relevant && !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    for root in resync {
        let plan = plan_repo(&root);
        lock(shared).apply_resync(&root, plan);
    }
    let due = run_due(shared, roots, Instant::now());
    for id in due.ids {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Outcome {
        ids,
        wake: due.wake,
    }
}

// ---------------------------------------------------------------- the handle

/// Owns the OS watcher and the set of watched roots.
pub struct WatcherHandle {
    emit: Emit,
    inner: Arc<Mutex<Inner>>,
    /// Every repo root, shared with the event thread.
    roots: Arc<RwLock<Vec<(PathBuf, String)>>>,
    /// Creating the watcher failed once; do not retry on every sync.
    failed: bool,
}

impl WatcherHandle {
    pub fn new(emit: Emit) -> Self {
        WatcherHandle {
            emit,
            inner: Arc::new(Mutex::new(Inner {
                watcher: None,
                repos: HashMap::new(),
                due: HashMap::new(),
                rules_dirty: HashSet::new(),
            })),
            roots: Arc::new(RwLock::new(Vec::new())),
            failed: false,
        }
    }

    /// Makes the watch set match `repos`. Failures are logged and never propagated. The walk of
    /// a new repo (and the questions to git it needs) runs with no lock held.
    pub fn sync(&mut self, repos: &[RepoInfo]) {
        let roots: Vec<(PathBuf, String)> = repos
            .iter()
            .map(|r| (PathBuf::from(&r.path), r.id.clone()))
            .collect();
        // Nested repos are watched on their own; the walk of their parent skips them.
        let wanted: HashSet<PathBuf> = roots.iter().map(|(p, _)| p.clone()).collect();
        *self.roots.write().unwrap_or_else(|e| e.into_inner()) = roots;

        if !self.failed && lock(&self.inner).watcher.is_none() {
            let watcher = self.start();
            self.failed = watcher.is_none();
            lock(&self.inner).watcher = watcher;
        }
        let fresh: Vec<PathBuf> = {
            let mut inner = lock(&self.inner);
            if inner.watcher.is_none() {
                return;
            }
            let gone: Vec<PathBuf> = inner
                .repos
                .keys()
                .filter(|r| !wanted.contains(*r))
                .cloned()
                .collect();
            for root in gone {
                inner.teardown(&root);
            }
            wanted
                .into_iter()
                .filter(|r| !inner.repos.contains_key(r))
                .collect()
        };
        for root in fresh {
            let plan = plan_repo(&root);
            let mut inner = lock(&self.inner);
            if !inner.repos.contains_key(&root) {
                inner.apply_setup(&root, plan);
            }
        }
    }

    /// Whether the OS file watcher could be started.
    #[cfg(test)]
    fn is_active(&self) -> bool {
        lock(&self.inner).watcher.is_some()
    }

    fn start(&self) -> Option<RecommendedWatcher> {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let tx = Mutex::new(tx);
        let watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(res);
            },
            Config::default(),
        );
        match watcher {
            Ok(w) => {
                // Weak: the watcher (owned by `inner`) owns the sender; when it is dropped the
                // channel closes and the thread ends.
                let shared = Arc::downgrade(&self.inner);
                let (roots, emit) = (self.roots.clone(), self.emit.clone());
                std::thread::spawn(move || event_loop(rx, shared, roots, emit));
                Some(w)
            }
            Err(e) => {
                tracing::warn!("file watcher disabled: {e}");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(p: &str) -> bool {
        relevant(
            &Path::new("/w/repo").join(p),
            Path::new("/w/repo"),
            &HashSet::new(),
        )
    }

    #[test]
    fn worktree_files_are_relevant() {
        assert!(rel("src/main.rs"));
        assert!(rel("Cargo.lock"));
        assert!(rel(".gitignore"));
        assert!(rel(".github/workflows/ci.yml"));
    }

    #[test]
    fn root_and_git_dir_are_not() {
        let none = HashSet::new();
        assert!(!relevant(Path::new("/w/repo"), Path::new("/w/repo"), &none));
        assert!(!rel(".git"));
        assert!(!relevant(
            Path::new("/elsewhere/x"),
            Path::new("/w/repo"),
            &none
        ));
    }

    #[test]
    fn git_state_files_are_relevant() {
        for f in [
            ".git/HEAD",
            ".git/index",
            ".git/packed-refs",
            ".git/MERGE_HEAD",
            ".git/CHERRY_PICK_HEAD",
            ".git/REVERT_HEAD",
            ".git/FETCH_HEAD",
            ".git/refs",
            ".git/refs/heads/main",
            ".git/refs/remotes/origin/feature/x",
            ".git/refs/stash",
            ".git/rebase-merge",
            ".git/rebase-merge/git-rebase-todo",
            ".git/rebase-apply/patch",
            ".git/info/exclude",
        ] {
            assert!(rel(f), "{f} should be relevant");
        }
    }

    #[test]
    fn other_git_internals_are_ignored() {
        for f in [
            ".git/objects/ab/cdef",
            ".git/logs/HEAD",
            ".git/config",
            ".git/COMMIT_EDITMSG",
            ".git/ORIG_HEAD",
            ".git/hooks/pre-commit",
            ".git/modules/sub/HEAD",
            ".git/info/attributes",
        ] {
            assert!(!rel(f), "{f} should be ignored");
        }
    }

    #[test]
    fn lock_files_inside_git_are_ignored() {
        assert!(!rel(".git/index.lock"));
        assert!(!rel(".git/HEAD.lock"));
        assert!(!rel(".git/refs/heads/main.lock"));
        assert!(!rel(".git/packed-refs.lock"));
    }

    #[test]
    fn only_the_skipped_folders_are_not_relevant() {
        let root = Path::new("/w/repo");
        let skipped: HashSet<PathBuf> = ["node_modules", "target", "web/dist", "a/b/.venv"]
            .iter()
            .map(|d| root.join(d))
            .collect();
        let rel = |p: &str| relevant(&root.join(p), root, &skipped);
        for f in [
            "node_modules",
            "node_modules/x/index.js",
            "target/debug/app",
            "web/dist/bundle.js",
            "a/b/.venv/lib/x.py",
        ] {
            assert!(!rel(f), "{f} should be ignored");
        }
        // Not decided by name: a tracked FILE called `build`, a folder named like a noisy one that
        // is not in the skipped set (git does not ignore it, or it holds tracked files).
        assert!(rel("build"));
        assert!(rel("dist/config.json"));
        assert!(rel("sub/out/x.txt"));
        assert!(rel("src/builder/mod.rs"));
        assert!(rel("outline.md"));
        assert!(rel("web/src/a.ts"));
    }

    #[test]
    fn rescan_flags_errors_and_pathless_events_mean_rescan() {
        let paths = |ev: Event| classify_event(&Ok(ev));
        let flagged = Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        assert_eq!(paths(flagged), Incoming::Rescan);
        let flagged_with_path = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(PathBuf::from("/w/a"))
            .set_flag(notify::event::Flag::Rescan);
        assert_eq!(paths(flagged_with_path), Incoming::Rescan);
        assert_eq!(
            paths(Event::new(EventKind::Other)),
            Incoming::Rescan,
            "an event without a path cannot be matched to a repo"
        );
        assert_eq!(
            paths(Event::new(EventKind::Access(
                notify::event::AccessKind::Any
            ))),
            Incoming::Nothing
        );
        assert_eq!(
            classify_event(&Err(notify::Error::generic("boom"))),
            Incoming::Rescan
        );
        let ev = Event::new(EventKind::Create(notify::event::CreateKind::File))
            .add_path(PathBuf::from("/w/a"));
        assert_eq!(paths(ev), Incoming::Paths(vec![PathBuf::from("/w/a")]));
    }

    #[test]
    fn pending_batches_paths_and_remembers_a_rescan() {
        let t = Instant::now();
        let mut p = Pending::default();
        p.add(Incoming::Nothing, t);
        assert!(p.since.is_none(), "noise does not start a batch");
        p.add(Incoming::Paths(vec![PathBuf::from("/a")]), t);
        let first = p.since;
        p.add(Incoming::Paths(vec![PathBuf::from("/b")]), t + DEBOUNCE);
        p.add(Incoming::Rescan, t + DEBOUNCE);
        assert_eq!(p.since, first, "the deadline runs from the first event");
        assert_eq!(p.paths.len(), 2);
        assert!(p.rescan);
    }

    #[test]
    fn ignore_rule_files_are_spotted() {
        let g = Path::new("/w/repo/.git");
        assert!(changes_ignore_rules(
            Path::new("/w/repo/.gitignore"),
            Some(g)
        ));
        assert!(changes_ignore_rules(
            Path::new("/w/repo/src/.gitignore"),
            None
        ));
        assert!(changes_ignore_rules(&g.join("info/exclude"), Some(g)));
        assert!(!changes_ignore_rules(&g.join("info/attributes"), Some(g)));
        assert!(!changes_ignore_rules(
            Path::new("/w/repo/src/a.rs"),
            Some(g)
        ));
    }

    #[test]
    fn branches_named_like_ignored_dirs_still_count_in_git() {
        assert!(rel(".git/refs/heads/build"));
        assert!(rel(".git/refs/heads/out/x"));
    }

    #[test]
    fn external_git_dir_filter() {
        let g = Path::new("/main/.git/worktrees/w");
        assert!(git_dir_relevant(&g.join("HEAD"), g));
        assert!(git_dir_relevant(&g.join("index"), g));
        assert!(!git_dir_relevant(&g.join("index.lock"), g));
        assert!(!git_dir_relevant(&g.join("gitdir"), g));
        assert!(!git_dir_relevant(g, g));
        assert!(!git_dir_relevant(Path::new("/elsewhere/HEAD"), g));
    }

    fn mkdirs(root: &Path, dirs: &[&str]) {
        for d in dirs {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
    }

    #[test]
    fn walker_skips_ignored_trees_git_and_nested_repos() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        mkdirs(
            root,
            &[
                "src/deep/er",
                "docs",
                "node_modules/pkg/lib",
                "target/debug/deps",
                "web/dist/assets",
                "web/src",
                ".venv/lib",
                ".git/refs/heads",
                "vendor/lib/.git",
                "vendor/lib/src",
            ],
        );
        let (dirs, truncated) = walk_dirs(root, 1000, &mut |_| Vec::new());
        assert!(!truncated);
        let rels: HashSet<String> = dirs
            .iter()
            .map(|d| {
                d.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        let want: HashSet<String> = [
            "",
            "src",
            "src/deep",
            "src/deep/er",
            "docs",
            "web",
            "web/src",
            "vendor",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(rels, want);
    }

    #[test]
    fn walker_respects_the_limit() {
        let tmp = tempfile::tempdir().unwrap();
        mkdirs(tmp.path(), &["a/x", "b", "c", "d"]);
        let (dirs, truncated) = walk_dirs(tmp.path(), 3, &mut |_| Vec::new());
        assert_eq!(dirs.len(), 3);
        assert!(truncated);
        assert_eq!(dirs[0], tmp.path());
        let (dirs, truncated) = walk_dirs(tmp.path(), 6, &mut |_| Vec::new());
        assert_eq!(dirs.len(), 6);
        assert!(!truncated);
    }

    #[test]
    fn walker_enters_ignored_named_dirs_that_git_lets_through() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        mkdirs(
            root,
            &["src", "build/gen", "web/dist/assets", "node_modules/pkg"],
        );
        // git only lets `build` and the nested `web/dist` through
        let mut allow = |c: &[PathBuf]| -> Vec<PathBuf> {
            c.iter()
                .filter(|p| p.ends_with("build") || p.ends_with("dist"))
                .cloned()
                .collect()
        };
        let (dirs, _) = walk_dirs(root, 1000, &mut allow);
        let has = |rel: &str| dirs.contains(&root.join(rel));
        assert!(has("src") && has("build") && has("build/gen"));
        assert!(has("web/dist") && has("web/dist/assets"));
        assert!(!has("node_modules") && !has("node_modules/pkg"));
    }

    pub(super) fn init_repo(root: &Path) {
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "t"],
        ] {
            let st = std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .status()
                .expect("git");
            assert!(st.success());
        }
    }

    pub(super) fn git(root: &Path, args: &[&str]) {
        let st = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .status()
            .expect("git");
        assert!(st.success(), "git {args:?}");
    }

    fn rels(root: &Path, dirs: &[PathBuf]) -> Vec<String> {
        let mut v: Vec<String> = dirs
            .iter()
            .map(|d| d.strip_prefix(root).unwrap().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn git_decides_which_named_dirs_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(tmp.path()).unwrap();
        init_repo(&root);
        let names = [
            "build",
            "out",
            "target",
            ".venv",
            "dist",
            "sub/build",
            "tools/node_modules",
        ];
        mkdirs(&root, &names);
        // `target/` is ignored by name, `dist/*` by a glob, `out/*` too but for one file,
        // `.venv` by a `.gitignore` of its own, `tools/node_modules` by a pattern that also
        // matches a tracked file name
        std::fs::write(
            root.join(".gitignore"),
            "target/\ndist/*\nout/*\n!out/keep.txt\n",
        )
        .unwrap();
        std::fs::write(root.join(".venv/.gitignore"), "*\n").unwrap();
        std::fs::write(root.join("out/keep.txt"), "k").unwrap();
        std::fs::write(root.join("dist/config.json"), "{}").unwrap();
        std::fs::write(root.join("tools/node_modules/.gitignore"), "*\n").unwrap();
        // tracked although ignored: `git add -f`
        git(&root, &["add", "-f", "dist/config.json", "out/keep.txt"]);
        let all: Vec<PathBuf> = names.iter().map(|d| root.join(d)).collect();
        let (watch, skip) = classify(&root, &all);
        assert_eq!(rels(&root, &watch), ["build", "dist", "out", "sub/build"]);
        assert_eq!(
            rels(&root, &skip),
            [".venv", "target", "tools/node_modules"]
        );
        // not a repository: git cannot say, so everything is skipped
        let plain = tempfile::tempdir().unwrap();
        let p = gitcore::paths::canonicalize(plain.path()).unwrap();
        mkdirs(&p, &["build"]);
        let (watch, skip) = classify(&p, &[p.join("build")]);
        assert!(watch.is_empty());
        assert_eq!(skip, [p.join("build")]);
    }

    #[test]
    fn a_folder_with_files_git_shows_is_never_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(tmp.path()).unwrap();
        init_repo(&root);
        let names = ["build", "dist", "out", ".venv", "target"];
        mkdirs(&root, &names);
        // `.*` hides the probe file of `build` but not `build/main.c`; `dist/*` hides everything
        // in dist but `keep.txt`, which is untracked and shown; `.venv` is wholly hidden by `.*`
        std::fs::write(
            root.join(".gitignore"),
            ".*\n!.gitignore\n/target/\ndist/*\n!dist/keep.txt\nout/*\n",
        )
        .unwrap();
        std::fs::write(root.join("build/main.c"), "int main;").unwrap();
        std::fs::write(root.join("dist/keep.txt"), "k").unwrap();
        std::fs::write(root.join("dist/junk.o"), "j").unwrap();
        std::fs::write(root.join("out/junk.o"), "j").unwrap();
        std::fs::write(root.join(".venv/x"), "x").unwrap();
        std::fs::write(root.join("target/x"), "x").unwrap();
        let all: Vec<PathBuf> = names.iter().map(|d| root.join(d)).collect();
        let (watch, skip) = classify(&root, &all);
        assert_eq!(rels(&root, &watch), ["build", "dist"]);
        assert_eq!(rels(&root, &skip), [".venv", "out", "target"]);
    }

    #[test]
    fn git_dir_resolution() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(resolve_git_dir(root), None);
        mkdirs(root, &["plain/.git", "real/gitdir"]);
        assert_eq!(
            resolve_git_dir(&root.join("plain")),
            Some(root.join("plain/.git"))
        );
        let wt = root.join("wt");
        std::fs::create_dir(&wt).unwrap();
        let abs = root.join("real/gitdir");
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", abs.display())).unwrap();
        assert_eq!(resolve_git_dir(&wt), Some(abs));
        std::fs::write(wt.join(".git"), "gitdir: ../real/gitdir\n").unwrap();
        assert_eq!(resolve_git_dir(&wt), Some(wt.join("../real/gitdir")));
        std::fs::write(wt.join(".git"), "gitdir: ../nope\n").unwrap();
        assert_eq!(resolve_git_dir(&wt), None);
    }

    #[test]
    fn owner_is_the_deepest_root() {
        let roots = vec![
            (PathBuf::from("/w"), "outer".to_string()),
            (PathBuf::from("/w/libs/inner"), "inner".to_string()),
            (PathBuf::from("/w/libs/inner2"), "other".to_string()),
        ];
        let id = |p: &str| owner(Path::new(p), &roots).map(|(_, id)| id.as_str());
        assert_eq!(id("/w/src/a.rs"), Some("outer"));
        assert_eq!(id("/w/libs/inner/src/a.rs"), Some("inner"));
        assert_eq!(id("/w/libs/inner2/.git/HEAD"), Some("other"));
        assert_eq!(id("/x/y"), None);
    }
}

#[cfg(test)]
mod live_tests {
    use super::tests::{git as gitc, init_repo};
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn emits_once_per_repo_for_worktree_changes_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        let (tx, rx) = mpsc::channel::<String>();
        let tx = std::sync::Mutex::new(tx);
        let mut w = WatcherHandle::new(Arc::new(move |id: &str| {
            let _ = tx.lock().unwrap().send(id.to_string());
        }));
        w.sync(&[RepoInfo {
            id: "r1".into(),
            name: "r1".into(),
            path: root.to_string_lossy().into_owned(),
        }]);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        // Noise only: ignored.
        std::fs::write(root.join(".git/objects/blob"), "x").unwrap();
        std::fs::write(root.join(".git/index.lock"), "x").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err());
        // A burst of worktree changes: one event.
        std::fs::write(root.join("a.txt"), "1").unwrap();
        std::fs::write(root.join("b.txt"), "2").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        // Windows (ReadDirectoryChangesW) can deliver the create and the write of a file in
        // separate bursts, so the debouncer may emit a second time: one refresh too many, never
        // a missed one. CI run 42798038150. Elsewhere the burst must give exactly one event.
        if cfg!(windows) {
            while let Ok(id) = rx.recv_timeout(Duration::from_millis(1000)) {
                assert_eq!(id, "r1");
            }
        } else {
            assert!(rx.recv_timeout(Duration::from_millis(1000)).is_err());
        }
        // Dropping the repo from the set stops events.
        w.sync(&[]);
        std::fs::write(root.join("c.txt"), "3").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err());
    }

    fn repo(root: &Path) -> RepoInfo {
        RepoInfo {
            id: "r1".into(),
            name: "r1".into(),
            path: root.to_string_lossy().into_owned(),
        }
    }

    /// The paths below `root` that made the watcher emit so far, for assertion messages.
    fn causes(root: &Path) -> Vec<PathBuf> {
        EMIT_CAUSES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|p| p.starts_with(root))
            .cloned()
            .collect()
    }

    /// Waits until the watcher has been quiet for a second (at most 10 s). Windows reports that a folder changed (something was made inside it)
    /// to the watch of the folder above, and it can do so late, also for a change made right
    /// before the watch was set up. Seen in CI run 42795486426: the test makes `.git/refs/heads`,
    /// the watches are set up, and then the watch of `.git` reports `.git\refs`. Such a
    /// notification is one refresh too many, not a missed one, so the steps that expect silence
    /// wait for quiet first.
    fn settle(rx: &mpsc::Receiver<String>) {
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(10)
            && rx.recv_timeout(Duration::from_millis(1000)).is_ok()
        {}
    }

    #[test]
    fn watches_new_directories_but_not_ignored_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".git/refs/heads")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        let (tx, rx) = mpsc::channel::<String>();
        let tx = std::sync::Mutex::new(tx);
        let mut w = WatcherHandle::new(Arc::new(move |id: &str| {
            let _ = tx.lock().unwrap().send(id.to_string());
        }));
        w.sync(&[repo(&root)]);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        {
            let inner = lock(&w.inner);
            let dirs = &inner.repos[&root].dirs;
            assert!(dirs.contains(&root));
            assert!(dirs.contains(&root.join(".git")));
            assert!(dirs.contains(&root.join(".git/refs")));
            assert!(!dirs
                .iter()
                .any(|d| d.starts_with(root.join("node_modules"))));
        }
        settle(&rx);
        // Activity in an ignored tree is invisible.
        std::fs::write(root.join("node_modules/pkg/x.js"), "x").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(1500)).is_err(),
            "a change below node_modules was reported; causes so far: {:?}",
            causes(&root)
        );
        // A new directory gets watched, and so do files created later inside it.
        std::fs::create_dir_all(root.join("src/inner")).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        settle(&rx);
        assert!(lock(&w.inner).repos[&root]
            .dirs
            .contains(&root.join("src/inner")));
        std::fs::write(root.join("src/inner/f.rs"), "1").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        // A new ignored directory is not watched.
        settle(&rx);
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(1500)).is_err(),
            "a new ignored folder was reported; causes so far: {:?}",
            causes(&root)
        );
        assert!(!lock(&w.inner).repos[&root]
            .dirs
            .iter()
            .any(|d| d.starts_with(root.join("target"))));
    }

    fn watcher_for(root: &Path) -> (WatcherHandle, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel::<String>();
        let tx = std::sync::Mutex::new(tx);
        let mut w = WatcherHandle::new(Arc::new(move |id: &str| {
            let _ = tx.lock().unwrap().send(id.to_string());
        }));
        w.sync(&[repo(root)]);
        (w, rx)
    }

    #[test]
    fn a_build_folder_that_git_does_not_ignore_is_watched() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        init_repo(&root);
        std::fs::create_dir_all(root.join("build/gen")).unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
        let (w, rx) = watcher_for(&root);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        {
            let inner = lock(&w.inner);
            let dirs = &inner.repos[&root].dirs;
            assert!(dirs.contains(&root.join("build")));
            assert!(dirs.contains(&root.join("build/gen")));
            assert!(!dirs.iter().any(|d| d.starts_with(root.join("target"))));
        }
        settle(&rx);
        // A change in the tracked-or-not-ignored folder is reported...
        std::fs::write(root.join("build/gen/out.txt"), "1").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        settle(&rx);
        // ...and so is a new folder inside it, and a file in that folder.
        std::fs::create_dir_all(root.join("build/new")).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        settle(&rx);
        std::fs::write(root.join("build/new/f.txt"), "1").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        settle(&rx);
        // The ignored one stays silent.
        std::fs::write(root.join("target/debug/x"), "1").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(1500)).is_err(),
            "a change below an ignored target/ was reported; causes so far: {:?}",
            causes(&root)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_removed_and_created_again_is_watched_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        init_repo(&root);
        std::fs::create_dir_all(root.join("src/inner")).unwrap();
        let (w, rx) = watcher_for(&root);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        settle(&rx);
        // Both happen inside one debounce window, like a checkout that rewrites the folder.
        std::fs::remove_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("src/inner")).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        settle(&rx);
        std::fs::write(root.join("src/inner/f.rs"), "1").unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            "r1",
            "a file in the re-created folder was not reported"
        );
    }

    #[test]
    fn an_ignored_folder_with_tracked_files_is_watched() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        init_repo(&root);
        std::fs::create_dir_all(root.join("dist/sub")).unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::write(root.join(".gitignore"), "dist/*\ntarget/\n").unwrap();
        std::fs::write(root.join("dist/config.json"), "{}").unwrap();
        gitc(&root, &["add", "-f", "dist/config.json"]);
        let (w, rx) = watcher_for(&root);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        {
            let inner = lock(&w.inner);
            let rw = &inner.repos[&root];
            assert!(rw.dirs.contains(&root.join("dist")));
            assert!(rw.dirs.contains(&root.join("dist/sub")));
            assert!(rw.skipped.contains(&root.join("target")));
            assert!(!rw.dirs.contains(&root.join("target")));
        }
        settle(&rx);
        std::fs::write(root.join("dist/config.json"), "{\"a\":1}").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
    }

    #[test]
    fn editing_a_gitignore_rebuilds_the_watch_set() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        init_repo(&root);
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::create_dir_all(root.join("build/gen")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
        let (w, rx) = watcher_for(&root);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        {
            let inner = lock(&w.inner);
            let rw = &inner.repos[&root];
            assert!(rw.skipped.contains(&root.join("target")));
            assert!(rw.dirs.contains(&root.join("build/gen")));
        }
        settle(&rx);
        // target/ is no longer ignored, build/ now is
        std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        settle(&rx);
        let inner = lock(&w.inner);
        let rw = &inner.repos[&root];
        assert!(!rw.skipped.contains(&root.join("target")));
        assert!(rw.dirs.contains(&root.join("target/debug")));
        assert!(rw.skipped.contains(&root.join("build")));
        assert!(!rw.dirs.iter().any(|d| d.starts_with(root.join("build"))));
    }

    #[test]
    fn a_rescan_notice_refreshes_every_repo_and_rebuilds_its_watches() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        init_repo(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        let (w, _rx) = watcher_for(&root);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        // A folder made while events were lost has no watch...
        std::fs::create_dir_all(root.join("late/er")).unwrap();
        assert!(!lock(&w.inner).repos[&root]
            .dirs
            .contains(&root.join("late")));
        let roots = vec![
            (root.clone(), "r1".to_string()),
            (PathBuf::from("/not/watched"), "r2".to_string()),
        ];
        let batch = Pending {
            rescan: true,
            ..Pending::default()
        };
        let out = process(&batch, &w.inner, &roots);
        assert_eq!(out.ids, ["r1", "r2"]);
        // ...until the rescan rebuilds the set.
        let inner = lock(&w.inner);
        assert!(inner.repos[&root].dirs.contains(&root.join("late")));
        assert!(inner.repos[&root].dirs.contains(&root.join("late/er")));
    }

    #[test]
    fn a_slow_git_is_given_up_on() {
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let out = run_git(
            dir.path(),
            &["-c", "alias.sl=!sleep 5", "sl"],
            None,
            Duration::from_millis(200),
        );
        assert!(out.is_none());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_rescan_inside_the_gap_is_postponed_not_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        init_repo(&root);
        let (w, _rx) = watcher_for(&root);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        let roots = vec![(root.clone(), "r1".to_string())];
        let batch = || Pending {
            rescan: true,
            ..Pending::default()
        };
        let first = process(&batch(), &w.inner, &roots);
        assert_eq!(first.ids, ["r1"]);
        assert!(first.wake.is_none());
        // Folders made while events were lost, and another rescan notice right after the first.
        std::fs::create_dir_all(root.join("lost/inside")).unwrap();
        let second = process(&batch(), &w.inner, &roots);
        assert!(
            second.ids.is_empty(),
            "the repo is not refreshed twice in a gap"
        );
        assert!(
            second.wake.is_some(),
            "the rescan waits for the end of the gap"
        );
        assert!(!lock(&w.inner).repos[&root]
            .dirs
            .contains(&root.join("lost")));
        // The gap ends: the postponed rescan runs, refreshes and finds the folders.
        lock(&w.inner).due.get_mut(&root).unwrap().rescan_last = Some(Instant::now() - RESCAN_GAP);
        let out = run_due(&w.inner, &roots, Instant::now());
        assert_eq!(out.ids, ["r1"]);
        assert!(out.wake.is_none());
        let inner = lock(&w.inner);
        assert!(inner.repos[&root].dirs.contains(&root.join("lost/inside")));
    }

    fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
        let start = Instant::now();
        while !ok() {
            assert!(
                start.elapsed() < Duration::from_secs(8),
                "timed out: {what}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn a_skipped_folder_is_watched_once_a_file_in_it_is_tracked() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        init_repo(&root);
        std::fs::create_dir_all(root.join("dist/sub")).unwrap();
        std::fs::write(root.join(".gitignore"), "dist/*\n").unwrap();
        std::fs::write(root.join("dist/a.txt"), "1").unwrap();
        let (w, rx) = watcher_for(&root);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        assert!(lock(&w.inner).repos[&root]
            .skipped
            .contains(&root.join("dist")));
        settle(&rx);
        gitc(&root, &["add", "-f", "dist/a.txt"]);
        wait_for("dist is watched after git add -f", || {
            let inner = lock(&w.inner);
            let rw = &inner.repos[&root];
            !rw.skipped.contains(&root.join("dist")) && rw.dirs.contains(&root.join("dist/sub"))
        });
    }

    #[test]
    fn skipped_folders_of_a_removed_folder_are_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        init_repo(&root);
        std::fs::create_dir_all(root.join("pkg/node_modules/x")).unwrap();
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        let (w, rx) = watcher_for(&root);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        assert!(lock(&w.inner).repos[&root]
            .skipped
            .contains(&root.join("pkg/node_modules")));
        settle(&rx);
        std::fs::remove_dir_all(root.join("pkg")).unwrap();
        wait_for("the skipped entry goes with its parent", || {
            !lock(&w.inner).repos[&root]
                .skipped
                .contains(&root.join("pkg/node_modules"))
        });
    }

    #[test]
    fn git_info_created_after_the_setup_gets_a_watch_and_its_rules_apply() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        init_repo(&root);
        let _ = std::fs::remove_dir_all(root.join(".git/info"));
        std::fs::create_dir_all(root.join("build/gen")).unwrap();
        let (w, rx) = watcher_for(&root);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        assert!(!lock(&w.inner).repos[&root]
            .dirs
            .contains(&root.join(".git/info")));
        assert!(lock(&w.inner).repos[&root]
            .dirs
            .contains(&root.join("build")));
        settle(&rx);
        std::fs::create_dir_all(root.join(".git/info")).unwrap();
        std::fs::write(root.join(".git/info/exclude"), "build/\n").unwrap();
        wait_for("info is watched and build/ is skipped", || {
            let inner = lock(&w.inner);
            let rw = &inner.repos[&root];
            rw.dirs.contains(&root.join(".git/info")) && rw.skipped.contains(&root.join("build"))
        });
    }
}
