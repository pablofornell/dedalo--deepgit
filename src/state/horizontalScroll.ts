/**
 * Horizontal wheel sensitivity of the File changes diff: limits, validation and the scaling of one wheel event. Pure
 * (no DOM, no store), so it is tested under node. `DiffViewer.tsx` calls `scaledHorizontalWheel`; `settings.ts` stores
 * the percent.
 *
 * The setting is a percent (25..300, step 5, default 100 = the browser's own response, i.e. 0.25x..3x), like the UI
 * scale: whole numbers keep the slider, the number box and the stored value free of float noise.
 */

export const H_SCROLL_MIN = 25;
export const H_SCROLL_MAX = 300;
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

/**
 * The horizontal distance in px that a wheel event should scroll after applying the sensitivity, or `null` when the
 * event is not a horizontal one or when the sensitivity is 100 (the browser then scrolls by itself, exactly as before).
 *
 * A wheel event is horizontal when `deltaX` is the larger part, or when Shift is held and the wheel turns vertically
 * (Shift + wheel is a horizontal scroll). `lineHeight` and `pageWidth` (px) convert line and page deltas.
 */
export function scaledHorizontalWheel(e: WheelLike, percent: number, lineHeight: number, pageWidth: number): number | null {
  const factor = sanitizeHScrollSensitivity(percent) / 100;
  if (factor === 1) return null;
  const shiftWheel = e.shiftKey && e.deltaX === 0 && e.deltaY !== 0;
  const raw = shiftWheel ? e.deltaY : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
  if (raw === 0) return null;
  const px = e.deltaMode === 1 ? raw * lineHeight : e.deltaMode === 2 ? raw * pageWidth : raw;
  return px * factor;
}
