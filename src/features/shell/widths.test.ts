// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_CHANGES_DETAILS_RATIO, MIN_DETAILS, MIN_MAIN, clampDetails, columnWidth, defaultDetails, defaultRatio, detailsPersistKey, maxDetails, maximizedDetails } from "./widths";

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
  it("gives the diff more space on Local changes after a double-click on the splitter", () => {
    expect(defaultRatio("changes")).toBe(DEFAULT_CHANGES_DETAILS_RATIO);
    expect(defaultDetails(1300, 6, defaultRatio("changes"))).toBe(780);
    expect(clampDetails(Number.NaN, 1300, 6, defaultRatio("changes"))).toBe(780);
    expect(defaultDetails(1300, 6, defaultRatio("changes"))).toBeGreaterThan(defaultDetails(1300, 6, defaultRatio("log")));
  });
  it("still leaves the main island its minimum on Local changes", () => {
    expect(defaultDetails(1000, 6, defaultRatio("changes"))).toBe(514);
  });
});

describe("column width on Local changes", () => {
  const base = { maximized: false, fullOnChanges: true, stored: 400, rowW: 1300, splitter: 6 };
  it("is the largest width the splitter allows while the flag is set, whatever is saved", () => {
    expect(columnWidth({ ...base, tab: "changes" })).toBe(maxDetails(1300, 6));
    expect(columnWidth({ ...base, tab: "changes", stored: Number.NaN })).toBe(1300 - MIN_MAIN - 6);
  });
  it("equals the drag maximum, so the first drag from there does not jump", () => {
    expect(columnWidth({ ...base, tab: "changes" })).toBe(maxDetails(1300, 6));
  });
  it("keeps the middle column its minimum, also in a small window", () => {
    expect(columnWidth({ ...base, tab: "changes", rowW: 1000 })).toBe(1000 - MIN_MAIN - 6);
    expect(columnWidth({ ...base, tab: "changes", rowW: 700 })).toBe(MIN_DETAILS);
  });
  it("uses the saved width (clamped) once the flag is cleared", () => {
    expect(columnWidth({ ...base, tab: "changes", fullOnChanges: false })).toBe(400);
    expect(columnWidth({ ...base, tab: "changes", fullOnChanges: false, stored: 5000 })).toBe(maxDetails(1300, 6));
    expect(columnWidth({ ...base, tab: "changes", fullOnChanges: false, stored: Number.NaN })).toBe(780);
  });
  it("does not touch the Log tab", () => {
    expect(columnWidth({ ...base, tab: "log" })).toBe(400);
    expect(columnWidth({ ...base, tab: "log", stored: Number.NaN })).toBe(546);
  });
  it("a maximized column wins", () => {
    expect(columnWidth({ ...base, tab: "changes", maximized: true })).toBe(maximizedDetails(1300, 6));
    expect(columnWidth({ ...base, tab: "log", maximized: true })).toBe(maximizedDetails(1300, 6));
  });
  it("a maximized column is never narrower than the largest normal width, also on a very wide row", () => {
    for (const rowW of [700, 860, 1300, 3200, 4000, 6000]) {
      for (const tab of ["log", "changes"] as const) {
        expect(columnWidth({ ...base, tab, rowW, maximized: true })).toBeGreaterThanOrEqual(columnWidth({ ...base, tab: "changes", rowW }));
      }
    }
    expect(columnWidth({ ...base, tab: "changes", rowW: 6000, maximized: true })).toBe(maxDetails(6000, 6));
  });
});
