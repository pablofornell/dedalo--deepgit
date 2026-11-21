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
  it("is not the default when the Log has a width", () => {
    expect(prefsAreDefault(withWidth(defaultPrefs(), "log", 450))).toBe(false);
  });
  it("ignores the Local changes width, which is never saved", () => {
    expect(prefsAreDefault(withWidth(defaultPrefs(), "changes", 500))).toBe(true);
  });
  it("is the default again when the Log width is NaN", () => {
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

  it("reads the saved Log width when it loads and ignores an old saved Local changes width", async () => {
    data.set("deepgit.ui.split.details", "450");
    data.set("deepgit.ui.split.details.changes", "520");
    const m = await import("./detailsWidth");
    expect(m.detailsPrefs().log).toBe(450);
    expect(Number.isNaN(m.detailsPrefs().changes)).toBe(true);
    expect(m.detailsWidthsAreDefault()).toBe(false);
  });
  it("a Local changes width dragged in a visit does not enable Reset and is dropped when the tab is opened again", async () => {
    const m = await import("./detailsWidth");
    m.setDetailsWidth("changes", 500);
    m.releaseFullOnChanges();
    expect(m.detailsWidthsAreDefault()).toBe(true);
    m.armFullOnChanges();
    expect(Number.isNaN(m.detailsPrefs().changes)).toBe(true);
    expect(m.fullOnChanges()).toBe(true);
  });
  it("sets both tabs to the default and clears both saved keys (also an old Local changes key)", async () => {
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
  it("starts Local changes at its largest width, releases it on a drag and re-arms it on a reset", async () => {
    const m = await import("./detailsWidth");
    expect(m.fullOnChanges()).toBe(true);
    m.releaseFullOnChanges();
    expect(m.fullOnChanges()).toBe(false);
    m.armFullOnChanges();
    expect(m.fullOnChanges()).toBe(true);
    m.releaseFullOnChanges();
    m.resetDetailsWidths();
    expect(m.fullOnChanges()).toBe(true);
  });
});
