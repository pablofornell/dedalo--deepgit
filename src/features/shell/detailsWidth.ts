/**
 * Width of the right column for each main tab. The Shell reads it and the Settings "Layout" section resets it.
 * The Log width is saved. The Local changes width is not: that tab opens at its largest width every time, so a width
 * dragged there only lasts until the tab is opened again. A value of NaN means "never dragged": the tab uses its
 * default share of the row.
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

/** True when the Log has no saved width. The Local changes width is not saved, so it does not count. */
export function prefsAreDefault(prefs: DetailsPrefs): boolean {
  return !Number.isFinite(prefs.log);
}

/** The persisted key of a tab, as the Splitter writes it (`deepgit.ui.split.details`, `deepgit.ui.split.details.changes`). */
const storeKey = (tab: MainTabKey) => "split." + detailsPersistKey(tab);

/** Reads the Log width saved by the Splitter; a missing or bad value gives NaN (default). Local changes is never read: an old saved value is ignored. */
function loadPrefs(): DetailsPrefs {
  const v = loadPersisted<number>(storeKey("log"), Number.NaN);
  return { log: Number.isFinite(v) ? v : Number.NaN, changes: Number.NaN };
}

const [prefs, setPrefs] = createSignal<DetailsPrefs>(loadPrefs());
const [resetCount, setResetCount] = createSignal(0);
// Local changes shows the column at its largest width until the user moves the splitter there. Not persisted: every start
// and every visit to the tab begins at the largest width again.
const [full, setFull] = createSignal(true);

/** Reactive widths in px of the right column for each tab (NaN = default). */
export const detailsPrefs = prefs;

/** Sets the width of one tab. The Splitter saves the Log width to localStorage when the drag ends; the Local changes width is not saved. */
export function setDetailsWidth(tab: MainTabKey, px: number): void {
  setPrefs((p) => withWidth(p, tab, px));
}

/** Reactive: true while Local changes shows the column at its largest width. */
export const fullOnChanges = full;

/** The Shell calls this when the main tab becomes Local changes: the column is at its largest width again. */
export function armFullOnChanges(): void {
  // The width dragged during the last visit is dropped, so nothing invisible stays behind.
  setPrefs((p) => withWidth(p, "changes", Number.NaN));
  setFull(true);
}

/** The user moved the splitter on Local changes: the saved width of that tab applies from now on. */
export function releaseFullOnChanges(): void {
  setFull(false);
}

/** Gives the Log its default width again, now and after a restart; Local changes goes back to its largest width. */
export function resetDetailsWidths(): void {
  for (const t of TABS) removePersisted(storeKey(t));
  setPrefs(defaultPrefs());
  setFull(true);
  setResetCount((n) => n + 1);
}

/** Reactive: true when the Log uses its default width (Local changes always opens at its largest width). */
export function detailsWidthsAreDefault(): boolean {
  return prefsAreDefault(prefs());
}

/** Reactive: grows by one on each reset, so the Shell can restore a maximized column. */
export const detailsResetCount = resetCount;
