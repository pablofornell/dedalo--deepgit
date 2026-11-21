/**
 * Pure part of the refresh on window focus: throttles the triggers and picks what is read again. The file watcher is
 * the main way the app learns about changes; this is the fallback for what it can miss (a full event queue, a folder
 * that cannot be watched, a change made while the machine slept), so coming back to the window shows the real state.
 * It is a light refresh: the working tree that is on screen, nothing of the log or the refs. Ctrl+R is the full reload.
 */

/** Triggers closer than this to the last refresh are dropped (`focus` and `visibilitychange` arrive together). */
export const FOCUS_REFRESH_GAP_MS = 2000;

export interface FocusRefreshDeps {
  now: () => number;
  /** False while the window is hidden. */
  visible: () => boolean;
  /** Reloads what is on screen. */
  run: () => void;
  gapMs?: number;
}

export function createFocusRefresh(d: FocusRefreshDeps): { trigger: () => boolean } {
  let last = Number.NEGATIVE_INFINITY;
  return {
    /** Runs the refresh unless one ran lately or the window is hidden. Returns whether it ran. */
    trigger() {
      const t = d.now();
      if (!d.visible() || t - last < (d.gapMs ?? FOCUS_REFRESH_GAP_MS)) return false;
      last = t;
      d.run();
      return true;
    },
  };
}

/**
 * The repos whose summary (the counts in the sidebar, the Local changes badge) is read again: the repos Local changes
 * shows while that tab is open, else only the focused one. Never the whole project: a summary costs several git calls,
 * and a project can have a hundred repos.
 */
export function summaryTargets(tab: string, scope: readonly string[], focused: string | undefined): string[] {
  if (tab === "changes" && scope.length > 0) return [...scope];
  return focused ? [focused] : [];
}
