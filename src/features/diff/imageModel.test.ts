// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ImageSide } from "../../api/types";
import {
  ZOOM_STEPS, base64ToBytes, canCompare, clampPercent, dimensionsLabel, fitScale, formatBytes, formatSizeDelta, hasBytes, imageChange, naturalSize,
  sanitizeImageMode, stepZoom, swipeFromPointer, unionSize, zoomLabel,
} from "./imageModel";

const side = (over: Partial<ImageSide> = {}): ImageSide => ({ size: 10, mime: "image/png", data: "AAAA", tooLarge: false, ...over });

describe("image diff model", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(4300)).toBe("4.2 KB");
    expect(formatBytes(10 * 1024 - 1)).toBe("10 KB");
    expect(formatBytes(13 * 1024)).toBe("13 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatBytes(-1)).toBe("");
  });

  it("formats the size change", () => {
    expect(formatSizeDelta(1000, 1000)).toBe("same size");
    expect(formatSizeDelta(1024, 2048)).toBe("+1.0 KB");
    expect(formatSizeDelta(2048, 1948)).toBe("-100 B");
  });

  it("tells added, deleted and modified apart", () => {
    expect(imageChange({ old: null, new: side() })).toBe("added");
    expect(imageChange({ old: side(), new: null })).toBe("deleted");
    expect(imageChange({ old: side(), new: side() })).toBe("modified");
    expect(imageChange({ old: null, new: null })).toBe("none");
  });

  it("compares only two usable pictures", () => {
    const ok = { old: false, new: false };
    expect(canCompare({ old: side(), new: side() }, ok)).toBe(true);
    expect(canCompare({ old: null, new: side() }, ok)).toBe(false);
    expect(canCompare({ old: side({ tooLarge: true, data: null }), new: side() }, ok)).toBe(false);
    expect(canCompare({ old: side(), new: side() }, { old: false, new: true })).toBe(false);
  });

  it("knows which side has bytes", () => {
    expect(hasBytes(side())).toBe(true);
    expect(hasBytes(side({ tooLarge: true, data: null }))).toBe(false);
    expect(hasBytes(null)).toBe(false);
  });

  it("gives an unsized picture a default box and unions two boxes", () => {
    expect(naturalSize(0, 0)).toEqual({ w: 300, h: 150 });
    expect(naturalSize(20, 10)).toEqual({ w: 20, h: 10 });
    expect(unionSize({ w: 100, h: 20 }, { w: 40, h: 80 })).toEqual({ w: 100, h: 80 });
    expect(unionSize(null, { w: 40, h: 80 })).toEqual({ w: 40, h: 80 });
  });

  it("fits a picture without growing it", () => {
    expect(fitScale({ w: 100, h: 50 }, { w: 400, h: 400 })).toBe(1);
    expect(fitScale({ w: 800, h: 400 }, { w: 400, h: 400 })).toBe(0.5);
    expect(fitScale({ w: 400, h: 800 }, { w: 400, h: 400 })).toBe(0.5);
    expect(fitScale({ w: 0, h: 0 }, { w: 400, h: 400 })).toBe(1);
    expect(fitScale({ w: 100, h: 100 }, { w: 0, h: 0 })).toBe(1);
  });

  it("steps the zoom up and down inside the list", () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.33, 1)).toBe(0.5);
    expect(stepZoom(0.33, -1)).toBe(0.25);
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1], 1)).toBe(16);
    expect(stepZoom(0.01, -1)).toBe(0.1);
    expect(zoomLabel(0.333)).toBe("33 %");
  });

  it("maps a pointer to the swipe divider", () => {
    expect(swipeFromPointer(150, 100, 200)).toBe(25);
    expect(swipeFromPointer(50, 100, 200)).toBe(0);
    expect(swipeFromPointer(500, 100, 200)).toBe(100);
    expect(swipeFromPointer(5, 0, 0)).toBe(50);
    expect(clampPercent(120)).toBe(100);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(33.4)).toBe(33);
  });

  it("labels dimensions", () => {
    expect(dimensionsLabel({ w: 120, h: 80 })).toBe("120 × 80 px");
    expect(dimensionsLabel(null)).toBe("");
  });

  it("decodes base64", () => {
    expect([...base64ToBytes("Zm9v")]).toEqual([102, 111, 111]);
    expect([...base64ToBytes("")]).toEqual([]);
  });

  it("falls back to side by side for an unknown stored mode", () => {
    expect(sanitizeImageMode("swipe")).toBe("swipe");
    expect(sanitizeImageMode("onion")).toBe("onion");
    expect(sanitizeImageMode("x")).toBe("sideBySide");
    expect(sanitizeImageMode(null)).toBe("sideBySide");
  });
});
