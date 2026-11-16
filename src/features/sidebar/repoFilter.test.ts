// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findMatch, normalizeQuery } from "./repoFilter";

describe("findMatch", () => {
  it("ignores case and returns the range in the original text", () => {
    expect(findMatch("Payments-API", "api")).toEqual({ start: 9, end: 12 });
    expect(findMatch("payments", "PAY")).toEqual({ start: 0, end: 3 });
  });

  it("ignores accents on both sides", () => {
    expect(findMatch("Café", "cafe")).toEqual({ start: 0, end: 4 });
    expect(findMatch("cafe", "CAFÉ")).toEqual({ start: 0, end: 4 });
    expect(findMatch("Ñandú-core", "nandu")).toEqual({ start: 0, end: 5 });
  });

  it("keeps the range exact when the accent is a combining mark", () => {
    const decomposed = "Cafe\u0301-x"; // "Café" typed as e + combining acute
    expect(findMatch(decomposed, "cafe")).toEqual({ start: 0, end: 5 });
    expect(findMatch(decomposed, "x")).toEqual({ start: 6, end: 7 });
  });

  it("returns null for an empty or blank query and for no match", () => {
    expect(findMatch("api", "")).toBeNull();
    expect(findMatch("api", "   ")).toBeNull();
    expect(findMatch("api", "web")).toBeNull();
  });

  it("trims the query", () => {
    expect(normalizeQuery("  Café ")).toBe("cafe");
    expect(findMatch("web", " we ")).toEqual({ start: 0, end: 2 });
  });
});
