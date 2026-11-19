// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_CHANGES_DETAILS_RATIO, MIN_DETAILS, clampDetails, defaultDetails, defaultRatio, detailsPersistKey, maxDetails, maximizedDetails } from "./widths";

describe("details width", () => {
  it("defaults to about 42 % of the row", () => {
    expect(defaultDetails(1300, 6)).toBe(546);
  });
  it("never goes below the minimum, even in a small window", () => {
    expect(clampDetails(100, 860, 6)).toBe(MIN_DETAILS);
    expect(defaultDetails(500, 6)).toBe(MIN_DETAILS);
  });
  it("leaves the main island its minimum width", () => {
    expect(maxDetails(1000, 6)).toBe(514);
    expect(clampDetails(900, 1000, 6)).toBe(514);
  });
  it("clamps an old persisted value and falls back to the default for a bad one", () => {
    expect(clampDetails(400, 1300, 6)).toBe(400);
    expect(clampDetails(Number.NaN, 1300, 6)).toBe(546);
    expect(clampDetails(null, 1300, 6)).toBe(546);
  });
  it("maximizes to most of the row and keeps a strip of the main island", () => {
    expect(maximizedDetails(1300, 6)).toBe(1300 - 6 - 200);
    expect(maximizedDetails(2000, 6)).toBe(2000 - 6 - 300);
    expect(maximizedDetails(860, 6)).toBe(654);
  });
});

describe("details width per main tab", () => {
  it("keeps the old key for the log and a separate key for Local changes", () => {
    expect(detailsPersistKey("log")).toBe("details");
    expect(detailsPersistKey("changes")).toBe("details.changes");
  });
  it("gives the diff more space on Local changes by default", () => {
    expect(defaultRatio("changes")).toBe(DEFAULT_CHANGES_DETAILS_RATIO);
    expect(defaultDetails(1300, 6, defaultRatio("changes"))).toBe(780);
    expect(clampDetails(Number.NaN, 1300, 6, defaultRatio("changes"))).toBe(780);
    expect(defaultDetails(1300, 6, defaultRatio("changes"))).toBeGreaterThan(defaultDetails(1300, 6, defaultRatio("log")));
  });
  it("still leaves the main island its minimum on Local changes", () => {
    expect(defaultDetails(1000, 6, defaultRatio("changes"))).toBe(514);
  });
});
