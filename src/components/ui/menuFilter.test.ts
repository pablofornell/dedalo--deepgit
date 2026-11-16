// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MenuItem } from "./Menu";
import { filterMenuItems } from "./menuFilter";

const items: MenuItem[] = [
  { label: "Projects", heading: true },
  { label: "Alpha", filterText: "Alpha" },
  { label: "Café", filterText: "Café" },
  { separator: true },
  { label: "Add project folder…" },
];

describe("filterMenuItems", () => {
  it("keeps every item for an empty or blank query", () => {
    expect(filterMenuItems(items, "")).toHaveLength(5);
    expect(filterMenuItems(items, "  ")).toHaveLength(5);
  });
  it("keeps only the items whose filterText holds the query, ignoring case and accents", () => {
    expect(filterMenuItems(items, "ALP").map((i) => i.label)).toEqual(["Alpha"]);
    expect(filterMenuItems(items, "cafe").map((i) => i.label)).toEqual(["Café"]);
  });
  it("hides headings, separators and actions while a query is on", () => {
    expect(filterMenuItems(items, "project")).toEqual([]);
  });
});
