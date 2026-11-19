// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPrefs, prefsAreDefault, withWidth } from "./detailsWidth";

describe("details width prefs", () => {
  it("starts with no saved width on both tabs", () => {
    const p = defaultPrefs();
    expect(Number.isNaN(p.log)).toBe(true);
    expect(Number.isNaN(p.changes)).toBe(true);
    expect(prefsAreDefault(p)).toBe(true);
  });
  it("changes only the width of the tab that was dragged", () => {
    const p = withWidth(defaultPrefs(), "changes", 500);
    expect(p.changes).toBe(500);
    expect(Number.isNaN(p.log)).toBe(true);
  });
  it("is not the default when one tab has a width", () => {
    expect(prefsAreDefault(withWidth(defaultPrefs(), "log", 450))).toBe(false);
    expect(prefsAreDefault(withWidth(defaultPrefs(), "changes", 500))).toBe(false);
  });
  it("is the default again when every width is NaN", () => {
    const p = withWidth(withWidth(defaultPrefs(), "log", 450), "log", Number.NaN);
    expect(prefsAreDefault(p)).toBe(true);
  });
});

describe("reset of the details widths", () => {
  const data = new Map<string, string>();
  beforeEach(() => {
    data.clear();
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the saved widths of both tabs when it loads", async () => {
    data.set("deepgit.ui.split.details", "450");
    data.set("deepgit.ui.split.details.changes", "520");
    const m = await import("./detailsWidth");
    expect(m.detailsPrefs()).toEqual({ log: 450, changes: 520 });
    expect(m.detailsWidthsAreDefault()).toBe(false);
  });
  it("sets both tabs to the default and clears both saved keys", async () => {
    data.set("deepgit.ui.split.details", "450");
    data.set("deepgit.ui.split.details.changes", "520");
    data.set("deepgit.ui.split.sidebar", "300");
    const m = await import("./detailsWidth");
    m.resetDetailsWidths();
    expect(m.detailsWidthsAreDefault()).toBe(true);
    expect(Number.isNaN(m.detailsPrefs().log)).toBe(true);
    expect(Number.isNaN(m.detailsPrefs().changes)).toBe(true);
    expect(data.has("deepgit.ui.split.details")).toBe(false);
    expect(data.has("deepgit.ui.split.details.changes")).toBe(false);
    // Other widths stay as they are.
    expect(data.get("deepgit.ui.split.sidebar")).toBe("300");
  });
  it("gives the default widths after a restart", async () => {
    data.set("deepgit.ui.split.details", "450");
    const first = await import("./detailsWidth");
    first.resetDetailsWidths();
    vi.resetModules();
    const second = await import("./detailsWidth");
    expect(second.detailsWidthsAreDefault()).toBe(true);
  });
  it("counts each reset, so the Shell can restore a maximized column", async () => {
    const m = await import("./detailsWidth");
    const before = m.detailsResetCount();
    m.resetDetailsWidths();
    expect(m.detailsResetCount()).toBe(before + 1);
  });
});
