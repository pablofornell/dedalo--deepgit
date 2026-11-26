# Plan — stage error on deleted files, and long error text

## Tasks

| ID | Task | Files | Agent (why) | Depends on |
|----|------|-------|-------------|------------|
| T1 | Make stage tolerate paths that are already staged or gone | `crates/gitcore/src/ops.rs`, `crates/gitcore/tests/ops.rs` | `implementer`, sonnet (git logic and a Rust regression test) | — |
| T2 | Wrap long words in the error toast | `src/components/ui/ui.css` | Coordinator, directly (a two-line CSS change that does not need a subagent) | — |
| R1 | Review of T1 and T2 | — | `reviewer` (a fresh agent; the author does not review its own work) | T1, T2 |

T1 and T2 do not touch the same files, so they run in parallel.

## T1 — root cause and fix

**Cause.** `ops::stage` (`ops.rs:170`) runs `git --literal-pathspecs add -A -- <paths>` and does not filter the paths. The same deletion can reach the stage step two times: a second click, the Space key or the menu before the list refreshes (the frontend has no guard for a stage that is still running). In the second call, the path is in neither the index nor the worktree. Git then exits 128 with `pathspec ... did not match any files` and stages **nothing** from that call. This was reproduced with git 2.43.

**Fix (in the backend, at the cause).** Before `add -A`, keep only the paths that git can match:
- The path exists on disk (use `symlink_metadata`, so that a broken symlink counts), **or**
- One `git --literal-pathspecs ls-files -z --cached -- <paths>` call lists the path, or a file below it (a folder row). Use the existing `covers()` helper.

Drop the other paths. These are deletions that git already staged, so to skip them is correct. If no path is left, return `Ok(())`. Use `check_rel` in the same way as `discard`. Keep `--literal-pathspecs`. This is the same rule that `unstage` already follows for stale rows (`ops.rs:215-221`).

**Not changed (no extra scope).** `src/api/mock.ts` already skips missing paths. The conflict functions in `conflicts.rs` have a similar weakness, but the request does not ask to change them. They are listed as a risk.

**Acceptance**
- If you stage the same deleted file two times, the second call returns Ok and the index stays the same.
- If you stage one deletion that is already staged together with two unstaged deletions, the call returns Ok and all three deletions are staged.
- The stage behaviour does not change for modified, new, renamed, folder and conflicted paths. All tests in `cargo test -p gitcore` pass.
- New tests in `crates/gitcore/tests/ops.rs` use paths with spaces, for example `Sprint 42/...`.

## T2 — fix

`.dg-toast-body` (`ui.css:256`) and `.dg-toast-title` (`ui.css:247`) have no wrap rule. A long path with no spaces is cut at the box edge, and the title can run under the close button. The fix adds `overflow-wrap: anywhere;` to both rules. This is the same rule that `statusbar.css`, `console.css` and `dialogs.css` already use. The 3-line clamp stays, so the toast does not grow. The full text stays in the console and in the alerts list. The console panel needs no change.

**Acceptance**
- A long path wraps inside the toast and does not go under the close button.
- The toast width stays the same.

## Decisions
- The fix goes in the backend and not in a frontend de-duplication step. The backend fix also covers a list that is out of date after a change made outside the app.
- The mock and the conflict functions do not change, because the request does not ask for them.

## Verify
- `cargo test -p gitcore`
- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`
- `npm test`, `npm run build`
