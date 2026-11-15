/** Which files the diff shows as pictures, decided by the file extension only (the same list as `image_mime` in gitcore). */

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
};

/** MIME type of an image file name (case-insensitive extension of the last path part), or null when it is not an image. A name that is only an extension (".png") has none, like in gitcore. */
export function imageMimeOf(path: string): string | null {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** True for png, jpg, jpeg, gif, webp, bmp, svg, ico and avif files. */
export function isImagePath(path: string): boolean {
  return imageMimeOf(path) !== null;
}
