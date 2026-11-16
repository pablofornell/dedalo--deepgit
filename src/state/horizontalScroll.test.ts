// @vitest-environment node
import { describe, expect, it } from "vitest";
import { H_SCROLL_DEFAULT, H_SCROLL_MAX, H_SCROLL_MIN, sanitizeHScrollSensitivity, scaledHorizontalWheel } from "./horizontalScroll";

const wheel = (deltaX: number, deltaY = 0, extra: { deltaMode?: number; shiftKey?: boolean } = {}) => ({ deltaX, deltaY, deltaMode: 0, shiftKey: false, ...extra });

describe("sanitizeHScrollSensitivity", () => {
  it("keeps valid percents and rounds to the step of 5", () => {
    expect(sanitizeHScrollSensitivity(100)).toBe(100);
    expect(sanitizeHScrollSensitivity(25)).toBe(25);
    expect(sanitizeHScrollSensitivity(300)).toBe(300);
    expect(sanitizeHScrollSensitivity(102)).toBe(100);
    expect(sanitizeHScrollSensitivity(103)).toBe(105);
  });

  it("clamps to 25..300", () => {
    expect(sanitizeHScrollSensitivity(1)).toBe(H_SCROLL_MIN);
    expect(sanitizeHScrollSensitivity(-50)).toBe(H_SCROLL_MIN);
    expect(sanitizeHScrollSensitivity(999)).toBe(H_SCROLL_MAX);
  });

  it("falls back to 100 for anything that is not a finite number", () => {
    for (const v of [NaN, Infinity, "150", null, undefined, {}, true]) expect(sanitizeHScrollSensitivity(v)).toBe(H_SCROLL_DEFAULT);
  });
});

describe("scaledHorizontalWheel", () => {
  it("returns null at 100%: the browser keeps its own response", () => {
    expect(scaledHorizontalWheel(wheel(40), 100, 20, 800)).toBeNull();
  });

  it("scales deltaX by the percent", () => {
    expect(scaledHorizontalWheel(wheel(40), 200, 20, 800)).toBe(80);
    expect(scaledHorizontalWheel(wheel(-40), 50, 20, 800)).toBe(-20);
    expect(scaledHorizontalWheel(wheel(40), 25, 20, 800)).toBe(10);
    expect(scaledHorizontalWheel(wheel(40), 300, 20, 800)).toBe(120);
  });

  it("treats Shift + vertical wheel as a horizontal scroll", () => {
    expect(scaledHorizontalWheel(wheel(0, 100, { shiftKey: true }), 150, 20, 800)).toBe(150);
    expect(scaledHorizontalWheel(wheel(0, -100, { shiftKey: true }), 50, 20, 800)).toBe(-50);
  });

  it("uses deltaX when the browser already swapped the axes for Shift", () => {
    expect(scaledHorizontalWheel(wheel(100, 0, { shiftKey: true }), 150, 20, 800)).toBe(150);
  });

  it("ignores vertical and mostly vertical events", () => {
    expect(scaledHorizontalWheel(wheel(0, 100), 200, 20, 800)).toBeNull();
    expect(scaledHorizontalWheel(wheel(5, 100), 200, 20, 800)).toBeNull();
    expect(scaledHorizontalWheel(wheel(0, 0), 200, 20, 800)).toBeNull();
  });

  it("converts line and page deltas to px before scaling", () => {
    expect(scaledHorizontalWheel(wheel(3, 0, { deltaMode: 1 }), 200, 20, 800)).toBe(120);
    expect(scaledHorizontalWheel(wheel(1, 0, { deltaMode: 2 }), 50, 20, 800)).toBe(400);
  });

  it("treats an invalid percent like the sanitizer does", () => {
    expect(scaledHorizontalWheel(wheel(40), NaN, 20, 800)).toBeNull();
    expect(scaledHorizontalWheel(wheel(40), 9999, 20, 800)).toBe(120);
  });
});
