/**
 * Fake image files for the browser mock (`file_images`): a small SVG for `.svg` paths and a real, valid PNG
 * (RGBA gradient with transparent corners, stored deflate blocks) for every other image path. The two sides of a
 * diff get different colours and sizes from their seeds, so the image diff has something to show.
 */
import { imageMimeOf } from "./imageFiles";
import type { FileImages, ImageSide } from "./types";

function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const b64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function chunk(type: string, data: Uint8Array): number[] {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

/** A `w` x `h` RGBA PNG: a diagonal gradient of the colour, transparent in the four corners. */
export function makePng(w: number, h: number, hue: number): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  const [r0, g0, b0] = hsl(hue, 0.65, 0.5);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const corner = Math.hypot(Math.min(x, w - 1 - x), Math.min(y, h - 1 - y)) < Math.min(w, h) * 0.18;
      raw[o] = Math.round(r0 * (1 - t) + 255 * t * 0.5);
      raw[o + 1] = Math.round(g0 * (1 - t) + 255 * t * 0.5);
      raw[o + 2] = Math.round(b0 * (1 - t) + 255 * t * 0.5);
      raw[o + 3] = corner ? 0 : 255;
    }
  }
  // zlib stream of stored (uncompressed) blocks
  const parts: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const len = Math.min(65535, raw.length - i);
    const last = i + len >= raw.length ? 1 : 0;
    parts.push(last, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255);
    for (let k = 0; k < len; k++) parts.push(raw[i + k]);
  }
  parts.push(...u32(adler32(raw)));
  const ihdr = new Uint8Array([...u32(w), ...u32(h), 8, 6, 0, 0, 0]);
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", new Uint8Array(parts)),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function makeSvg(w: number, h: number, hue: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect x="4" y="4" width="${w - 8}" height="${h - 8}" rx="12" fill="hsl(${hue} 65% 50%)"/>` +
    `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="hsl(${(hue + 150) % 360} 70% 60%)"/>` +
    `</svg>`
  );
}

/** One fake side: the same seed always gives the same file. */
export function mockImageSide(path: string, seed: string): ImageSide {
  const mime = imageMimeOf(path) ?? "image/png";
  const hash = hashOf(seed);
  const hue = hash % 360;
  const w = 96 + (hash % 5) * 24;
  const h = 64 + ((hash >> 8) % 4) * 16;
  if (mime === "image/svg+xml") {
    const text = makeSvg(w + 64, h + 56, hue);
    return { size: new TextEncoder().encode(text).length, mime, data: btoa(text), tooLarge: false };
  }
  const bytes = makePng(w, h, hue);
  // The data is a PNG whatever the extension is: a browser shows it, and the mime tells what the data is.
  return { size: bytes.length, mime: "image/png", data: b64(bytes), tooLarge: false };
}

/** The sides of a mock diff: `old` is missing for an added file, `new` for a deleted one. */
export function mockFileImages(path: string, oldPath: string | null, seed: string, status: "added" | "modified" | "deleted"): FileImages {
  return {
    old: status === "added" ? null : mockImageSide(oldPath ?? path, seed + "-old"),
    new: status === "deleted" ? null : mockImageSide(path, seed + "-new"),
  };
}
