/**
 * Reads the working tree again when the window gets the focus or becomes visible again (throttled): it catches the
 * changes the file watcher missed. Light on purpose (see `focusRefreshCore`); Ctrl+R still reloads everything.
 *
 *   startFocusRefresh();   // once, from App
 */
import { untrack } from "solid-js";
import { notifyWorkingTreeChanged } from "./events";
import { createFocusRefresh, summaryTargets } from "./focusRefreshCore";
import { changesScopeRepos, mainTab } from "./selection";
import { focusedRepo, projectRepos, refreshSummaries } from "./workspace";

let started = false;

export function startFocusRefresh(): void {
  if (started || typeof window === "undefined" || typeof document === "undefined") return;
  started = true;
  const refresh = createFocusRefresh({
    now: () => Date.now(),
    visible: () => document.visibilityState !== "hidden",
    run: () =>
      untrack(() => {
        // Only a reader that is mounted and visible (the Local changes list, the diff of a local file) does any work.
        for (const r of projectRepos()) notifyWorkingTreeChanged(r.id);
        const ids = summaryTargets(mainTab(), changesScopeRepos().map((r) => r.id), focusedRepo()?.id);
        if (ids.length > 0) void refreshSummaries(ids);
      }),
  });
  window.addEventListener("focus", () => refresh.trigger());
  document.addEventListener("visibilitychange", () => refresh.trigger());
}
