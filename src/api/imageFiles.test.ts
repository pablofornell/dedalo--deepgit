// @vitest-environment node
import { describe, expect, it } from "vitest";
import { imageMimeOf, isImagePath } from "./imageFiles";

describe("image file detection", () => {
  it("accepts the nine image extensions", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]) {
      expect(isImagePath(`assets/logo.${ext}`)).toBe(true);
    }
  });

  it("ignores the case of the extension", () => {
    expect(isImagePath("Photo.JPG")).toBe(true);
    expect(isImagePath("a/b/Icon.Svg")).toBe(true);
  });

  it("rejects other files, names without an extension and dotfiles", () => {
    expect(isImagePath("src/main.rs")).toBe(false);
    expect(isImagePath("README")).toBe(false);
    expect(isImagePath("png")).toBe(false);
    expect(isImagePath(".png")).toBe(false);
    expect(isImagePath("dir.png/file")).toBe(false);
    expect(isImagePath("a.png.txt")).toBe(false);
    expect(isImagePath("a.pngx")).toBe(false);
    expect(isImagePath("")).toBe(false);
  });

  it("reads the last path part with / or \\ separators", () => {
    expect(isImagePath("a\\b\\c.gif")).toBe(true);
    expect(isImagePath("a.d/b")).toBe(false);
  });

  it("gives the MIME type", () => {
    expect(imageMimeOf("x.jpeg")).toBe("image/jpeg");
    expect(imageMimeOf("x.SVG")).toBe("image/svg+xml");
    expect(imageMimeOf("x.ico")).toBe("image/x-icon");
    expect(imageMimeOf("x.txt")).toBeNull();
  });
});
