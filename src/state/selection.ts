/**
 * What the user selected: which main tab is active and, for each main tab, the state of the right column. Each main tab
 * (Log, Local changes) owns its own right column: the commit (or stash) that "Changed files" shows, the file whose diff
 * "File changes" shows, and which of these two tabs is open. A switch of the main tab shows the state of that tab; the
 * other tab keeps its state until the user goes back to it. A tab that has opened nothing shows the empty states.
 *
 * - Log: the commit is the one selected in the log (`selectedCommit()`, also a stash picked in the sidebar on Log).
 * - Local changes: the commit is null until a stash is picked in the sidebar while Local changes is active; its files
 *   come from the Local changes list (and from the files of that stash).
 *
 * `detailsCommit()`, `selectedFile()` and `detailsTab()` give the values of the ACTIVE main tab. `commitFor(tab)`,
 * `fileFor(tab)`, `detailsTabFor(tab)` and the `tab` option of the setters read or write one main tab, also while the
 * other one is active. All of this is in memory only.
 *
 *   setSelectedCommit({ repoId, oid });                                  // the Log commit
 *   setSelectedCommit({ repoId, oid, stash }, { tab: "changes" });       // the stash that Local changes shows
 *   jumpToCommit({ repoId, oid });   // select it and pulse its node in the log
 *   selectFile({ repoId, spec: { kind: "commit", oid }, path });         // the active main tab
 *   selectFile({ repoId, spec: { kind: "staged" }, path }, { tab: "changes" });
 *   <Show when={selectedFile()}>{(f) => <DiffViewer repoId={f().repoId} spec={f().spec} path={f().path} />}</Show>
 */
import { type Accessor, type Setter, batch, createEffect, createRoot, createSignal, on } from "solid-js";
import type { DiffSpec, RepoInfo } from "../api/types";
import { changesCount, changesScope } from "./changesScope";
import { onActiveProjectChanged, projectRepos, selectedRepoIds, selectedRepos, setFocusedRepoId, summary } from "./workspace";

export interface SelectedCommit {
  repoId: string;
  oid: string;
  /** Set when a stash is selected: `oid` is then the stash commit. Not a log row. */
  stash?: { index: number };
}

export interface SelectedFile {
  repoId: string;
  spec: DiffSpec;
  path: string;
  oldPath?: string;
}

/** The commit a jump selected: its graph node pulses. `id` is new for every jump, also to the same commit. */
export interface CommitJump {
  repoId: string;
  oid: string;
  id: number;
}

export type MainTab = "log" | "changes";
/** Tabs of the right column: "files" = Changed files (commit details), "diff" = File changes (the diff of the selected file). */
export type DetailsTab = "files" | "diff";

/** The state of the right column that one main tab owns. */
interface ColumnState {
  commit: Accessor<SelectedCommit | null>;
  setCommit: Setter<SelectedCommit | null>;
  file: Accessor<SelectedFile | null>;
  setFile: Setter<SelectedFile | null>;
  dTab: Accessor<DetailsTab>;
  setDTab: Setter<DetailsTab>;
}

function columnState(): ColumnState {
  const [commit, setCommit] = createSignal<SelectedCommit | null>(null);
  const [file, setFile] = createSignal<SelectedFile | null>(null);
  const [dTab, setDTab] = createSignal<DetailsTab>("files");
  return { commit, setCommit, file, setFile, dTab, setDTab };
}

const columns: Record<MainTab, ColumnState> = { log: columnState(), changes: columnState() };
const [tab, setTab] = createSignal<MainTab>("log");
const [changesRepo, setChangesRepo] = createSignal<string | null>(null);
const [target, setTarget] = createSignal<CommitJump | null>(null);
let jumps = 0;

/** The commit selected in the log (reactive). This is the commit of the Log tab, also while Local changes is active. */
export const selectedCommit = columns.log.commit;
/** The commit (or stash) that "Changed files" shows for main tab `t` (reactive). */
export const commitFor = (t: MainTab): SelectedCommit | null => columns[t].commit();
/** The commit (or stash) that "Changed files" shows for the active main tab (reactive). */
export const detailsCommit = (): SelectedCommit | null => columns[tab()].commit();
/** The file whose diff "File changes" shows for main tab `t` (reactive). */
export const fileFor = (t: MainTab): SelectedFile | null => columns[t].file();
/** The file whose diff "File changes" shows for the active main tab (reactive). */
export const selectedFile = (): SelectedFile | null => columns[tab()].file();
/** Active tab of the main island (reactive). */
export const mainTab = tab;
/** Repo shown in the Local changes tab when a single repo is scoped (reactive). */
export const changesRepoId = changesRepo;
/** Open tab of the right column for main tab `t` (reactive). */
export const detailsTabFor = (t: MainTab): DetailsTab => columns[t].dTab();
/** Open tab of the right column for the active main tab (reactive). */
export const detailsTab = (): DetailsTab => columns[tab()].dTab();
/** The commit the last jump selected, until the selection moves to another commit (reactive). */
export const jumpTarget = target;

/**
 * Repos the Local changes view shows (reactive): the single repo picked in the sidebar / the Uncommitted changes row,
 * else the repos that pass the repo filter (the project-level view).
 */
export const changesScopeRepos = (): RepoInfo[] => changesScope(projectRepos(), selectedRepos(), changesRepo());
/** Changed files in `changesScopeRepos()` (reactive): the number the Local changes badges show. */
export const changesScopeCount = (): number => changesCount(changesScopeRepos(), summary);

/**
 * Selects a commit (or none) and focuses its repo. By default this is the commit of the Log tab (also while Local
 * changes is active); `{ tab: "changes" }` sets the stash that Local changes shows. The selected file of that main tab
 * stays: `CommitDetails` re-points it to the new commit when the commit changes the same path, and drops it (back to
 * "Changed files") when it does not. Selecting no commit drops a commit file at once. A new commit while "File
 * changes" shows no file returns to "Changed files".
 */
export function setSelectedCommit(c: SelectedCommit | null, opts?: { tab?: MainTab; focus?: boolean }): void {
  const which = opts?.tab ?? "log";
  const col = columns[which];
  const prev = col.commit();
  const t = target();
  // The jump target is a log row: only the Log commit can move away from it.
  if (which === "log" && t && !(c && c.repoId === t.repoId && c.oid === t.oid)) setTarget(null);
  if (prev?.repoId === c?.repoId && prev?.oid === c?.oid && prev?.stash?.index === c?.stash?.index) return;
  col.setCommit(c);
  if (!c && col.file()?.spec.kind === "commit") {
    col.setFile(null);
    col.setDTab("files");
  }
  if (c) {
    // `focus: false`: a refresh (a stash index moved), not a pick by the user, so the focused repo stays.
    if (opts?.focus !== false) setFocusedRepoId(c.repoId);
    // File changes with no file selected is an empty view: show Changed files for the new commit. With a file open,
    // `CommitDetails` decides (follow the file or drop it and return to Changed files).
    if (col.dTab() === "diff" && !col.file()) col.setDTab("files");
  }
}

/**
 * Selects a commit like `setSelectedCommit` and marks it as the target of a jump (a branch or tag picked in the
 * sidebar, `H`): the Log tab opens, the log scrolls to it and its node pulses. A click or an arrow key in the log does not call this.
 */
export function jumpToCommit(c: SelectedCommit): void {
  batch(() => {
    // The jump shows the commit in the log: on Local changes the right column of that tab has no part in it.
    setTab("log");
    setSelectedCommit(c);
    setTarget({ repoId: c.repoId, oid: c.oid, id: ++jumps });
  });
}

/**
 * Selects the file shown in the "File changes" tab (or none) of main tab `opts.tab`, else of the active main tab. By
 * default the right column of that main tab switches to "File changes"; pass `{ reveal: false }` to select quietly
 * (keyboard moves in the file tree, re-pointing after a commit change or a stage).
 */
export function selectFile(f: SelectedFile | null, opts?: { reveal?: boolean; tab?: MainTab }): void {
  const col = columns[opts?.tab ?? tab()];
  col.setFile(f);
  if (f) {
    setFocusedRepoId(f.repoId);
    if (opts?.reveal !== false) col.setDTab("diff");
  }
}

/** Opens a tab of the right column of main tab `which` (by default the active main tab). */
export function setDetailsTab(t: DetailsTab, which?: MainTab): void {
  columns[which ?? tab()].setDTab(t);
}

export function setMainTab(t: MainTab): void {
  setTab(t);
}

export function setChangesRepoId(repoId: string | null): void {
  setChangesRepo(repoId);
}

/** Clears the commit, the file and the right column tab of both main tabs. */
export function clearSelection(): void {
  batch(() => {
    for (const col of Object.values(columns)) {
      col.setCommit(null);
      col.setFile(null);
      col.setDTab("files");
    }
    setTarget(null);
  });
}

// Changing the repo filter (show all, hide a repo, only this one) goes back to the project-level Local changes view;
// otherwise a repo picked earlier would keep hiding the others after the user asked to see them.
createRoot(() => {
  let last = selectedRepoIds().join("\0");
  createEffect(
    on(selectedRepoIds, (ids) => {
      const key = ids.join("\0");
      if (key === last) return;
      last = key;
      setChangesRepo(null);
    }, { defer: true }),
  );
});

// A commit, file or changes repo of the old project means nothing in the new one.
onActiveProjectChanged(() => {
  clearSelection();
  setChangesRepoId(null);
});
