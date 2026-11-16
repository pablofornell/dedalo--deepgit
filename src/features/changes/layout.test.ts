// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isCompact, stagedHeight } from "./layout";

describe("isCompact", () => {
  it("is false while the list minimum and the full commit box fit", () => {
    expect(isCompact(400, 120, 176)).toBe(false);
    expect(isCompact(296, 120, 176)).toBe(false);
  });
  it("is true when they do not fit", () => {
    expect(isCompact(295, 120, 176)).toBe(true);
    expect(isCompact(150, 120, 176)).toBe(true);
  });
  it("ignores an unmeasured (hidden) island", () => {
    expect(isCompact(0, 120, 176)).toBe(false);
  });
});

describe("stagedHeight", () => {
  it("splits the area in half until the user drags the divider", () => {
    expect(stagedHeight(400, null, 76)).toBe(200);
    expect(stagedHeight(401, Number.NaN, 76)).toBe(201);
  });
  it("keeps the dragged height", () => {
    expect(stagedHeight(400, 120, 76)).toBe(120);
  });
  it("keeps both zones at their minimum", () => {
    expect(stagedHeight(400, 10, 76)).toBe(76);
    expect(stagedHeight(400, 390, 76)).toBe(324);
  });
  it("gives the Staged zone its minimum when the area is too small for two", () => {
    expect(stagedHeight(120, null, 76)).toBe(76);
    expect(stagedHeight(0, null, 76)).toBe(76);
  });
});
