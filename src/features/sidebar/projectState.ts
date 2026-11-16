/**
 * What the sidebar tree keeps open, per project: the expanded repos / groups / remotes, the "N more…" lists that were
 * opened and the selected row. It is saved as the user changes it and restored when the project becomes active again, so a
 * project switch brings back the tree as it was left (open folders are `collapsed.ts`; the focused repo is
 * `state/projectFocus.ts`). Pure: the component reads and writes the storage.
 */

export interface SidebarProjectState {
  /** Ids of the open repos, groups and remotes (never folders: those are saved as collapsed). */
  expanded: string[];
  /** Group ids whose "N more…" was clicked. */
  moreOpen: string[];
  selected: string | null;
}

/** Local-storage key of a project (`savePersisted` / `loadPersisted`). */
export const sidebarStateKey = (projectId: string | null | undefined): string => `sidebar.projectState.${projectId ?? "none"}`;

/** True when node id `id` (`repo:R`, `grp:R:local`, `rem:R:origin`, `b:R:main`, ...) belongs to one of the repos `repoIds`. */
export function nodeInRepos(id: string, repoIds: readonly string[]): boolean {
  return repoIds.some((r) => id.endsWith(`:${r}`) || id.includes(`:${r}:`));
}

/**
 * The state for a project seen for the first time: nothing expanded, except that a project with a single repo shows its
 * Local and origin groups open (that tree has no repo row to open them from). The selected row is the focused repo's, as
 * always, so selecting it does not open anything.
 */
export function defaultSidebarState(repoIds: readonly string[], focusedId: string | null): SidebarProjectState {
  if (repoIds.length === 1) return { expanded: [`grp:${repoIds[0]}:local`, `rem:${repoIds[0]}:origin`], moreOpen: [], selected: null };
  return { expanded: [], moreOpen: [], selected: focusedId !== null && repoIds.includes(focusedId) ? `repo:${focusedId}` : null };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The state to show for a project: what was saved (`raw`), without the ids of repos that left the project, or the default
 * when nothing usable was saved. A saved state is never extended: nothing opens that the user did not leave open.
 */
export function restoreSidebarState(raw: unknown, repoIds: readonly string[], focusedId: string | null): SidebarProjectState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaultSidebarState(repoIds, focusedId);
  const r = raw as Record<string, unknown>;
  const selected = typeof r.selected === "string" && (r.selected.startsWith("dir:") || nodeInRepos(r.selected, repoIds)) ? r.selected : null;
  return {
    expanded: strings(r.expanded).filter((id) => nodeInRepos(id, repoIds)),
    moreOpen: strings(r.moreOpen).filter((id) => nodeInRepos(id, repoIds)),
    selected,
  };
}
