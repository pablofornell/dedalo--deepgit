// @vitest-environment node
import { describe, expect, it } from "vitest";
import { autoScrollDelta, combineSelection, marqueeMode, passedThreshold, rectBetween, rowsInRect } from "./marquee";

describe("rectBetween", () => {
  it("orders the corners whichever way the pointer moved", () => {
    expect(rectBetween(10, 40, 4, 8)).toEqual({ left: 4, top: 8, right: 10, bottom: 40 });
    expect(rectBetween(4, 8, 10, 40)).toEqual({ left: 4, top: 8, right: 10, bottom: 40 });
  });
});

describe("passedThreshold", () => {
  it("stays a click until the pointer travelled the threshold on one axis", () => {
    expect(passedThreshold(0, 0)).toBe(false);
    expect(passedThreshold(3, -3)).toBe(false);
    expect(passedThreshold(4, 0)).toBe(true);
    expect(passedThreshold(-1, -5)).toBe(true);
  });
});

describe("rowsInRect", () => {
  const h = 24;
  it("returns the rows the rectangle touches", () => {
    expect(rowsInRect({ top: 30, bottom: 80 }, h, 10)).toEqual([1, 2, 3]);
  });
  it("hits the single row of a zero-height rectangle", () => {
    expect(rowsInRect({ top: 50, bottom: 50 }, h, 10)).toEqual([2]);
  });
  it("does not reach the next row when the bottom edge is on a row boundary", () => {
    expect(rowsInRect({ top: 24, bottom: 48 }, h, 10)).toEqual([1]);
    expect(rowsInRect({ top: 0, bottom: 72 }, h, 10)).toEqual([0, 1, 2]);
  });
  it("clamps to the rows that exist", () => {
    expect(rowsInRect({ top: -40, bottom: 30 }, h, 10)).toEqual([0, 1]);
    expect(rowsInRect({ top: 200, bottom: 900 }, h, 10)).toEqual([8, 9]);
  });
  it("is empty above the first row and in the empty space below the last", () => {
    expect(rowsInRect({ top: -50, bottom: -10 }, h, 10)).toEqual([]);
    expect(rowsInRect({ top: 240, bottom: 300 }, h, 10)).toEqual([]);
    expect(rowsInRect({ top: 0, bottom: 100 }, h, 0)).toEqual([]);
  });
});

describe("marqueeMode", () => {
  it("replaces by default, adds with Shift, toggles with Ctrl", () => {
    expect(marqueeMode({ ctrl: false, shift: false })).toBe("replace");
    expect(marqueeMode({ ctrl: false, shift: true })).toBe("add");
    expect(marqueeMode({ ctrl: true, shift: false })).toBe("toggle");
    expect(marqueeMode({ ctrl: true, shift: true })).toBe("toggle");
  });
});

describe("combineSelection", () => {
  const base = new Set(["a", "b"]);
  it("replace drops the old selection", () => {
    expect([...combineSelection(base, ["c", "d"], "replace")]).toEqual(["c", "d"]);
    expect([...combineSelection(base, [], "replace")]).toEqual([]);
  });
  it("add keeps the old selection", () => {
    expect([...combineSelection(base, ["b", "c"], "add")]).toEqual(["a", "b", "c"]);
  });
  it("toggle flips the rows under the band and keeps the others", () => {
    expect([...combineSelection(base, ["b", "c"], "toggle")].sort()).toEqual(["a", "c"]);
  });
  it("toggle flips a key once even when it is listed twice, and never changes the base", () => {
    expect([...combineSelection(base, ["c", "c"], "toggle")].sort()).toEqual(["a", "b", "c"]);
    expect([...base]).toEqual(["a", "b"]);
  });
});

describe("autoScrollDelta", () => {
  it("does not scroll in the middle of the list", () => {
    expect(autoScrollDelta(150, 0, 300)).toBe(0);
    expect(autoScrollDelta(28, 0, 300)).toBe(0);
    expect(autoScrollDelta(272, 0, 300)).toBe(0);
  });
  it("scrolls up near the top edge and down near the bottom edge", () => {
    expect(autoScrollDelta(10, 0, 300)).toBeLessThan(0);
    expect(autoScrollDelta(290, 0, 300)).toBeGreaterThan(0);
  });
  it("is faster the closer the pointer is to the edge and fastest outside the list", () => {
    expect(Math.abs(autoScrollDelta(2, 0, 300))).toBeGreaterThan(Math.abs(autoScrollDelta(20, 0, 300)));
    expect(autoScrollDelta(-500, 0, 300)).toBe(-22);
    expect(autoScrollDelta(900, 0, 300)).toBe(22);
  });
  it("always moves at least one pixel inside a band", () => {
    expect(autoScrollDelta(27, 0, 300)).toBe(-1);
    expect(autoScrollDelta(273, 0, 300)).toBe(1);
  });
  it("works in viewport coordinates and in a list shorter than two bands", () => {
    expect(autoScrollDelta(110, 100, 400)).toBeLessThan(0);
    expect(autoScrollDelta(120, 100, 130)).toBeGreaterThan(0);
    expect(autoScrollDelta(105, 100, 130)).toBeLessThan(0);
  });
});
