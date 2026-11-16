/**
 * The focused repo of each project. It is saved per project, so switching project brings back the repo the user left
 * focused there (the same way the sidebar keeps its open folders and repos per project).
 */

/** Local-storage key of a project (`savePersisted` / `loadPersisted`). */
export const focusKey = (projectId: string | null | undefined): string => `focusedRepo.${projectId ?? "none"}`;

/**
 * The repo to focus in a project whose repos are `repoIds` (sidebar order): the one focused now when it belongs to the
 * project (rescan, clone, removal of another project), else the saved one, else the first repo. The first repo is only a
 * fallback for a project that has no saved focus; it is not saved until the user focuses a repo.
 */
export function resolveFocus(repoIds: readonly string[], current: string | null, saved: unknown): string | null {
  if (current !== null && repoIds.includes(current)) return current;
  if (typeof saved === "string" && repoIds.includes(saved)) return saved;
  return repoIds[0] ?? null;
}
