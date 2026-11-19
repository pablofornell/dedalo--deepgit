/**
 * Saved width of the right column for each main tab. The Shell reads it and the Settings "Layout" section resets it.
 * A value of NaN means "never dragged": the tab uses its default share of the row.
 */
import { createSignal } from "solid-js";
import { loadPersisted, removePersisted } from "../../state/persist";
import { type MainTabKey, detailsPersistKey } from "./widths";

export type DetailsPrefs = Record<MainTabKey, number>;

const TABS: MainTabKey[] = ["log", "changes"];

/** Prefs of a user who never dragged the column. */
export function defaultPrefs(): DetailsPrefs {
  return { log: Number.NaN, changes: Number.NaN };
}

/** `prefs` with the width of one tab changed. */
export function withWidth(prefs: DetailsPrefs, tab: MainTabKey, px: number): DetailsPrefs {
  return { ...prefs, [tab]: px };
}

/** True when no tab has a saved width. */
export function prefsAreDefault(prefs: DetailsPrefs): boolean {
  return TABS.every((t) => !Number.isFinite(prefs[t]));
}

/** The persisted key of a tab, as the Splitter writes it (`deepgit.ui.split.details`, `deepgit.ui.split.details.changes`). */
const storeKey = (tab: MainTabKey) => "split." + detailsPersistKey(tab);

/** Reads the widths saved by the Splitter; a missing or bad value gives NaN (default). */
function loadPrefs(): DetailsPrefs {
  const read = (tab: MainTabKey) => {
    const v = loadPersisted<number>(storeKey(tab), Number.NaN);
    return Number.isFinite(v) ? v : Number.NaN;
  };
  return { log: read("log"), changes: read("changes") };
}

const [prefs, setPrefs] = createSignal<DetailsPrefs>(loadPrefs());
const [resetCount, setResetCount] = createSignal(0);

/** Reactive widths in px of the right column for each tab (NaN = default). */
export const detailsPrefs = prefs;

/** Sets the width of one tab. The Splitter saves it to localStorage when the drag ends. */
export function setDetailsWidth(tab: MainTabKey, px: number): void {
  setPrefs((p) => withWidth(p, tab, px));
}

/** Gives both tabs their default width again, now and after a restart. */
export function resetDetailsWidths(): void {
  for (const t of TABS) removePersisted(storeKey(t));
  setPrefs(defaultPrefs());
  setResetCount((n) => n + 1);
}

/** Reactive: true when both tabs use their default width. */
export function detailsWidthsAreDefault(): boolean {
  return prefsAreDefault(prefs());
}

/** Reactive: grows by one on each reset, so the Shell can restore a maximized column. */
export const detailsResetCount = resetCount;
