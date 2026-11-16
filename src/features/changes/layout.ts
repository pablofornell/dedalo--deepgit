/** Vertical layout of the Local changes tab (file list above, commit box below). */

import { cssPx } from "../../state/metrics";

export { cssPx };

/**
 * True when the island is too short for the file list at its minimum plus the full commit box. `available` is the
 * island height without the notice and banner rows above the list.
 */
export function isCompact(available: number, listMin: number, commitMin: number): boolean {
  return available > 0 && available < listMin + commitMin;
}

/**
 * Height of the Staged zone inside a file area of `total` px. `pref` is what the user dragged the divider to (null or
 * NaN: not set yet, the two zones share the area). Both zones keep at least `min`, so neither can be squeezed out of
 * sight; when the area is too small for two minimums the Staged zone gets `min` and the Unstaged zone the rest.
 */
export function stagedHeight(total: number, pref: number | null, min: number): number {
  const wanted = pref !== null && Number.isFinite(pref) ? pref : Math.round(total / 2);
  return Math.round(Math.max(min, Math.min(wanted, total - min)));
}
