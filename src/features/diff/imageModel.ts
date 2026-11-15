/** Pure helpers of the image diff: what to show for the two sides, sizes, zoom, the swipe divider and the onion opacity. */
import type { FileImages, ImageSide } from "../../api/types";

export type ImageMode = "sideBySide" | "swipe" | "onion";
export const IMAGE_MODES: readonly ImageMode[] = ["sideBySide", "swipe", "onion"];

/** A value read from storage may be anything: unknown modes fall back to side by side. */
export function sanitizeImageMode(v: unknown): ImageMode {
  return IMAGE_MODES.includes(v as ImageMode) ? (v as ImageMode) : "sideBySide";
}

/** "812 B", "4.2 KB", "13 KB", "1.5 MB" (1024 based, one decimal under 10). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  // 9.96 would round to "10.0": use no decimal from 9.95 on
  return `${v < 9.95 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** "+1.2 KB", "-300 B", "same size". */
export function formatSizeDelta(oldSize: number, newSize: number): string {
  const d = newSize - oldSize;
  if (d === 0) return "same size";
  return `${d > 0 ? "+" : "-"}${formatBytes(Math.abs(d))}`;
}

export type ImageChange = "added" | "deleted" | "modified" | "none";

/** What the two sides say about the change. */
export function imageChange(images: FileImages): ImageChange {
  if (images.old && images.new) return "modified";
  if (images.new) return "added";
  if (images.old) return "deleted";
  return "none";
}

/** Swipe and onion skin compare two pictures; a missing, too large or undecodable side only allows the plain view. */
export function canCompare(images: FileImages, failed: { old: boolean; new: boolean }): boolean {
  const { old: o, new: n } = images;
  return !!o && !!n && !o.tooLarge && !n.tooLarge && !failed.old && !failed.new;
}

export interface Size {
  w: number;
  h: number;
}

/** Layout size of an image: SVG files without a size report 0; they get a default box. */
export function naturalSize(w: number, h: number): Size {
  return w > 0 && h > 0 ? { w, h } : { w: 300, h: 150 };
}

/** The box that holds both pictures (the bigger of each dimension), so a swipe or onion skin shows how they differ in size. */
export function unionSize(a: Size | null, b: Size | null): Size {
  return { w: Math.max(a?.w ?? 0, b?.w ?? 0), h: Math.max(a?.h ?? 0, b?.h ?? 0) };
}

/** Scale that fits `box` into `avail` without growing it above 100 %. A box or area of 0 gives 1. */
export function fitScale(box: Size, avail: Size): number {
  if (box.w <= 0 || box.h <= 0 || avail.w <= 0 || avail.h <= 0) return 1;
  return Math.min(1, avail.w / box.w, avail.h / box.h);
}

export const ZOOM_STEPS: readonly number[] = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8, 16];

/** The next zoom step above (`dir` 1) or below (-1) `scale`, staying inside the list. */
export function stepZoom(scale: number, dir: 1 | -1): number {
  const eps = 1e-6;
  if (dir > 0) return ZOOM_STEPS.find((z) => z > scale + eps) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < scale - eps) return ZOOM_STEPS[i];
  return ZOOM_STEPS[0];
}

/** "100 %", "33 %". */
export function zoomLabel(scale: number): string {
  return `${Math.round(scale * 100)} %`;
}

/** The divider of the swipe view, in percent of the width, from a pointer x inside the box. */
export function swipeFromPointer(clientX: number, left: number, width: number): number {
  if (width <= 0) return 50;
  return Math.min(100, Math.max(0, ((clientX - left) / width) * 100));
}

export const clampPercent = (v: number): number => Math.min(100, Math.max(0, Math.round(v)));

/** "120 × 80 px" (or an empty string while the picture has not loaded). */
export function dimensionsLabel(size: Size | null): string {
  return size ? `${size.w} × ${size.h} px` : "";
}

/** Standard base64 to bytes (the Blob of an `<img>` is made from them). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when the side carries bytes the browser can be given. */
export function hasBytes(side: ImageSide | null): side is ImageSide & { data: string } {
  return !!side && !side.tooLarge && side.data !== null;
}
