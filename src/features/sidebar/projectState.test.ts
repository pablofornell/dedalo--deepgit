// @vitest-environment node
// The sidebar tree of a project stays as the user left it across project switches; a project seen for the first time
// opens nothing (bug: every switch expanded the first repo).
import { describe, expect, it } from "vitest";
import { defaultSidebarState, nodeInRepos, restoreSidebarState, sidebarStateKey } from "./projectState";

describe("sidebar state per project", () => {
  it("keys the saved state by project", () => {
    expect(sidebarStateKey("p1")).toBe("sidebar.projectState.p1");
    expect(sidebarStateKey(undefined)).toBe("sidebar.projectState.none");
  });

  it("recognizes the nodes of a repo", () => {
    expect(nodeInRepos("repo:r1", ["r1"])).toBe(true);
    expect(nodeInRepos("grp:r1:local", ["r1"])).toBe(true);
    expect(nodeInRepos("rem:r1:origin", ["r1"])).toBe(true);
    expect(nodeInRepos("b:r1:feature/x", ["r1"])).toBe(true);
    expect(nodeInRepos("repo:r2", ["r1"])).toBe(false);
    expect(nodeInRepos("grp:r10:local", ["r1"])).toBe(false);
  });

  it("opens nothing in a multi-repo project seen for the first time (only the focused row is selected)", () => {
    const s = restoreSidebarState(null, ["a", "b", "c"], "b");
    expect(s.expanded).toEqual([]);
    expect(s.moreOpen).toEqual([]);
    expect(s.selected).toBe("repo:b");
    expect(defaultSidebarState(["a", "b"], null).selected).toBeNull();
  });

  it("shows Local and origin of a single-repo project, which has no repo row to open them from", () => {
    expect(defaultSidebarState(["a"], "a").expanded).toEqual(["grp:a:local", "rem:a:origin"]);
  });

  it("brings back exactly what was saved, without opening the first repo", () => {
    const saved = { expanded: ["repo:c", "grp:c:local"], moreOpen: ["grp:c:local"], selected: "b:c:main" };
    expect(restoreSidebarState(saved, ["a", "b", "c"], "c")).toEqual(saved);
    // a project left with everything closed stays closed
    expect(restoreSidebarState({ expanded: [], moreOpen: [], selected: null }, ["a", "b", "c"], "a")).toEqual({ expanded: [], moreOpen: [], selected: null });
  });

  it("drops the ids of repos that left the project", () => {
    const s = restoreSidebarState({ expanded: ["repo:a", "repo:gone", "grp:gone:local"], moreOpen: ["grp:gone:tags"], selected: "repo:gone" }, ["a", "b"], "a");
    expect(s).toEqual({ expanded: ["repo:a"], moreOpen: [], selected: null });
  });

  it("keeps a selected folder row, and falls back to the default for unusable data", () => {
    expect(restoreSidebarState({ expanded: [], moreOpen: [], selected: "dir:IRIS" }, ["a", "b"], "a").selected).toBe("dir:IRIS");
    for (const bad of ["x", 3, [], undefined]) expect(restoreSidebarState(bad, ["a", "b"], "a")).toEqual(defaultSidebarState(["a", "b"], "a"));
    expect(restoreSidebarState({ expanded: "repo:a", moreOpen: [1, null] }, ["a", "b"], "a")).toEqual({ expanded: [], moreOpen: [], selected: null });
  });
});
