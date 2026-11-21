// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RETRIES, RETRY_MS, createRetrier } from "./loadRetry";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("load retry", () => {
  it("runs the next attempt after the delay", () => {
    const r = createRetrier();
    const run = vi.fn();
    expect(r.schedule(0, () => true, run)).toBe(true);
    vi.advanceTimersByTime(RETRY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledWith(1);
  });

  it("gives up after the limit", () => {
    const r = createRetrier();
    const run = vi.fn();
    expect(r.schedule(MAX_RETRIES, () => true, run)).toBe(false);
    vi.advanceTimersByTime(RETRY_MS * 5);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips the run when a newer read took over", () => {
    const r = createRetrier();
    const run = vi.fn();
    let current = true;
    r.schedule(1, () => current, run);
    current = false;
    vi.advanceTimersByTime(RETRY_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it("cancels everything planned", () => {
    const r = createRetrier();
    const run = vi.fn();
    r.schedule(0, () => true, run);
    r.schedule(1, () => true, run);
    r.cancelAll();
    vi.advanceTimersByTime(RETRY_MS * 5);
    expect(run).not.toHaveBeenCalled();
  });
});
