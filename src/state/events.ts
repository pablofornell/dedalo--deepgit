/**
 * Backend events, subscribed exactly once (`startEvents()` from App). Other stores and features
 * react through the helpers here instead of calling `onRepoChanged` themselves.
 *
 *   // re-run a query whenever a repo changes:
 *   createEffect(() => { repoVersion(props.repoId); reload(); });
 *   // or imperatively:
 *   onCleanup(subscribeRepoChanged((repoId) => …));
 */
import { createSignal } from "solid-js";
import { onGitConsole, onRepoChanged } from "../api/tauri";
import { pushConsoleEntry } from "./console";

const repoListeners = new Set<(repoId: string) => void>();
const versions = new Map<string, ReturnType<typeof createSignal<number>>>();
const workingTreeVersions = new Map<string, ReturnType<typeof createSignal<number>>>();
const [anyVersion, setAnyVersion] = createSignal(0);

function versionSignal(repoId: string) {
  let s = versions.get(repoId);
  if (!s) versions.set(repoId, (s = createSignal(0)));
  return s;
}

/** Reactive counter that increases every time `repoId` changes (read it inside an effect/memo). */
export function repoVersion(repoId: string): number {
  return versionSignal(repoId)[0]();
}

/**
 * Reactive counter that increases when the working tree of `repoId` should be read again without any change being
 * known (the window got the focus back). Unlike `repoVersion` it moves no one else: not the log, the refs nor the
 * summaries. A reader of the working tree (Local changes, the diff of a local file) reads both counters.
 */
export function workingTreeVersion(repoId: string): number {
  let s = workingTreeVersions.get(repoId);
  if (!s) workingTreeVersions.set(repoId, (s = createSignal(0)));
  return s[0]();
}

/** Asks the readers of `workingTreeVersion(repoId)` to read again. */
export function notifyWorkingTreeChanged(repoId: string): void {
  workingTreeVersion(repoId);
  workingTreeVersions.get(repoId)?.[1]((n) => n + 1);
}

/** Reactive counter that increases when any repo changes. */
export function anyRepoVersion(): number {
  return anyVersion();
}

/** Calls `cb(repoId)` for every `repo-changed` event. Returns the unsubscribe function. */
export function subscribeRepoChanged(cb: (repoId: string) => void): () => void {
  repoListeners.add(cb);
  return () => repoListeners.delete(cb);
}

/** Marks a repo as changed without a backend event (used by actions after a successful write). */
export function notifyRepoChanged(repoId: string): void {
  const [, set] = versionSignal(repoId);
  set((n) => n + 1);
  setAnyVersion((n) => n + 1);
  repoListeners.forEach((cb) => cb(repoId));
}

let started = false;

/** Subscribes to `git-console`, `repo-changed` and the credential prompts (`state/auth.ts`) once. Safe to call repeatedly. */
export function startEvents(): void {
  if (started) return;
  started = true;
  void onGitConsole(pushConsoleEntry);
  void onRepoChanged((e) => notifyRepoChanged(e.repoId));
  // loaded on demand: the dialog code pulls in the UI components, which tests of the state modules cannot import
  void import("./auth").then((m) => m.startAuth());
}
