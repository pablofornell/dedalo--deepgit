// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FOCUS_REFRESH_GAP_MS, createFocusRefresh, summaryTargets } from "./focusRefreshCore";

function harness() {
  const h = { t: 1_000_000, visible: true, runs: 0 };
  const r = createFocusRefresh({ now: () => h.t, visible: () => h.visible, run: () => void h.runs++ });
  return { h, r };
}

describe("focus refresh", () => {
  it("runs on the first trigger", () => {
    const { h, r } = harness();
    expect(r.trigger()).toBe(true);
    expect(h.runs).toBe(1);
  });

  it("drops the second trigger of the same focus (focus + visibilitychange)", () => {
    const { h, r } = harness();
    r.trigger();
    h.t += 50;
    expect(r.trigger()).toBe(false);
    expect(h.runs).toBe(1);
  });

  it("runs again once the gap has passed", () => {
    const { h, r } = harness();
    r.trigger();
    h.t += FOCUS_REFRESH_GAP_MS;
    expect(r.trigger()).toBe(true);
    expect(h.runs).toBe(2);
  });

  it("does nothing while the window is hidden, and does not use up the gap", () => {
    const { h, r } = harness();
    h.visible = false;
    expect(r.trigger()).toBe(false);
    h.visible = true;
    expect(r.trigger()).toBe(true);
    expect(h.runs).toBe(1);
  });
});

describe("what a focus refresh reads", () => {
  it("reads the summaries of the repos Local changes shows while that tab is open", () => {
    expect(summaryTargets("changes", ["a", "b"], "c")).toEqual(["a", "b"]);
  });

  it("reads only the focused repo otherwise, never the whole project", () => {
    expect(summaryTargets("log", ["a", "b"], "c")).toEqual(["c"]);
    expect(summaryTargets("changes", [], "c")).toEqual(["c"]);
    expect(summaryTargets("log", [], undefined)).toEqual([]);
  });
});
