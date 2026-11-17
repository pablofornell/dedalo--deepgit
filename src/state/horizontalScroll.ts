/**
 * Horizontal wheel sensitivity of the File changes diff: limits, validation and the scaling of one wheel event. Pure
 * (no DOM, no store), so it is tested under node. `DiffViewer.tsx` calls `scaledHorizontalWheel`; `settings.ts` stores
 * the percent.
 *
 * The setting is a percent (25..1000, step 5, default 100 = the browser's own response, i.e. 0.25x..10x), like the UI
 * scale: whole numbers keep the slider, the number box and the stored value free of float noise.
 */

export const H_SCROLL_MIN = 25;
export const H_SCROLL_MAX = 1000;
export const H_SCROLL_STEP = 5;
export const H_SCROLL_DEFAULT = 100;

/** Percent, rounded to the step and kept inside the limits. Anything that is not a finite number becomes the default. */
export function sanitizeHScrollSensitivity(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return H_SCROLL_DEFAULT;
  const stepped = Math.round(v / H_SCROLL_STEP) * H_SCROLL_STEP;
  return Math.min(H_SCROLL_MAX, Math.max(H_SCROLL_MIN, stepped));
}

/** The subset of a `WheelEvent` that the scaling reads. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (`WheelEvent.deltaMode`). */
  deltaMode: number;
  shiftKey: boolean;
}

/** The scroll that one wheel event should do after the sensitivity: `x` is scaled, `y` is the vertical part in px. */
export interface ScaledWheel {
  x: number;
  y: number;
}

/**
 * The scroll that a wheel event should do after applying the sensitivity, or `null` when the event is not a horizontal
 * one or when the sensitivity is 100 (the browser then scrolls by itself, exactly as before).
 *
 * A wheel event is horizontal when Shift is held (Shift + wheel is a horizontal scroll: the larger axis is used, as
 * WebKit may already have swapped them), or when `deltaX` is at least as large as `deltaY`. Trackpads send both axes
 * for a small wrist swipe, and the old strict test (`|deltaX| > |deltaY|`) let the even ones scroll at 1x. The vertical
 * part of a diagonal swipe is kept in `y`, so the caller can scroll it too after it cancels the native scroll.
 * `lineHeight`, `pageWidth` and `pageHeight` (px) convert line and page deltas.
 */
export function scaledHorizontalWheel(
  e: WheelLike,
  percent: number,
  lineHeight: number,
  pageWidth: number,
  pageHeight = pageWidth,
): ScaledWheel | null {
  const factor = sanitizeHScrollSensitivity(percent) / 100;
  if (factor === 1) return null;
  const toPx = (d: number, page: number) => (e.deltaMode === 1 ? d * lineHeight : e.deltaMode === 2 ? d * page : d);
  let raw: number;
  let vertical = 0;
  if (e.shiftKey) {
    raw = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  } else if (e.deltaX !== 0 && Math.abs(e.deltaX) >= Math.abs(e.deltaY)) {
    raw = e.deltaX;
    vertical = e.deltaY;
  } else return null;
  if (raw === 0) return null;
  // `+ 0` turns -0 into 0
  return { x: toPx(raw, pageWidth) * factor, y: toPx(vertical, pageHeight) + 0 };
}
