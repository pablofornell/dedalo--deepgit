/**
 * Pure logic of the rubber-band (marquee) selection of the Local changes lists: the rectangle, the rows it touches,
 * how it combines with the selection that was there before and the speed of the auto-scroll near the edges.
 * No Solid, no DOM: unit tested in `marquee.test.ts`. The pointer handling is in `PaneList.tsx`.
 */

/** A rectangle in the content coordinates of a list (y = 0 is the top of the first row, whatever the scroll position). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Pointer travel (px) before a press turns into a rubber band; below it the press is a click. */
export const DRAG_THRESHOLD = 4;
/** Height (px) of the band at the top and the bottom edge of the list where a drag scrolls it. */
export const SCROLL_EDGE = 28;
/** Fastest auto-scroll (px per frame). */
export const SCROLL_MAX_SPEED = 22;

/** The rectangle between two corners, in any order. */
export function rectBetween(ax: number, ay: number, bx: number, by: number): Rect {
  return { left: Math.min(ax, bx), top: Math.min(ay, by), right: Math.max(ax, bx), bottom: Math.max(ay, by) };
}

/** True once the pointer has left the click zone around where it was pressed. */
export function passedThreshold(dx: number, dy: number, threshold: number = DRAG_THRESHOLD): boolean {
  return Math.max(Math.abs(dx), Math.abs(dy)) >= threshold;
}

/**
 * Indexes of the rows (fixed `rowHeight`, `count` of them from y = 0) that the rectangle touches. Rows span the
 * whole width of the list, so only the vertical extent matters. Empty when the rectangle is outside the rows
 * (above the first, or in the empty space below the last).
 */
export function rowsInRect(rect: Pick<Rect, "top" | "bottom">, rowHeight: number, count: number): number[] {
  if (count <= 0 || rowHeight <= 0 || rect.bottom < 0 || rect.top >= count * rowHeight) return [];
  const first = Math.max(0, Math.floor(rect.top / rowHeight));
  // a bottom edge exactly on a row boundary does not reach the row below
  const last = Math.min(count - 1, Math.max(first, Math.ceil(rect.bottom / rowHeight) - 1));
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

export type MarqueeMode = "replace" | "add" | "toggle";

/** Plain drag replaces the selection, Shift adds to it, Ctrl (Cmd) toggles the rows the band touches. */
export function marqueeMode(mods: { ctrl: boolean; shift: boolean }): MarqueeMode {
  return mods.ctrl ? "toggle" : mods.shift ? "add" : "replace";
}

/**
 * Selection while the band is on screen: `base` is the selection when the drag started and `hit` the keys under the
 * band now. Recomputed from `base` on every move, so rows drop out again when the band shrinks.
 */
export function combineSelection(base: ReadonlySet<string>, hit: readonly string[], mode: MarqueeMode): Set<string> {
  if (mode === "replace") return new Set(hit);
  if (mode === "add") return new Set([...base, ...hit]);
  const out = new Set(base);
  for (const k of new Set(hit)) {
    if (!out.delete(k)) out.add(k);
  }
  return out;
}

/**
 * Pixels to scroll per frame for a pointer at `y`, in a list that spans `top`..`bottom` (same coordinate space).
 * Zero in the middle, growing towards the edge and beyond it (a pointer dragged out of the list scrolls fastest).
 * Negative scrolls up.
 */
export function autoScrollDelta(y: number, top: number, bottom: number, edge: number = SCROLL_EDGE, max: number = SCROLL_MAX_SPEED): number {
  // a list shorter than two bands: split it in half so the two zones never overlap
  const band = Math.max(1, Math.min(edge, (bottom - top) / 2));
  if (y < top + band) return -Math.min(max, Math.max(1, Math.round(((top + band - y) / band) * max)));
  if (y > bottom - band) return Math.min(max, Math.max(1, Math.round(((y - (bottom - band)) / band) * max)));
  return 0;
}
