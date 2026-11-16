// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FileChange, WorkingTree } from "../../api/types";
import {
  buildRows, buildTree, commitLabel, dirKey, fileKey, groupByRepo, nearestSurvivor, paneOfKey, rangeKeys, repoKey, rowItems, sectionKey,
  selectedItems, stashFilesOf, subjectLength, type Row,
} from "./model";

const file = (path: string, status: FileChange["status"] = "modified"): FileChange => ({
  path, oldPath: null, status, additions: 1, deletions: 0, binary: false,
});
const wt = (staged: string[], unstaged: string[], conflicted: string[] = []): WorkingTree => ({
  repoId: "r1", staged: staged.map((p) => file(p)), unstaged: unstaged.map((p) => file(p)), conflicted: conflicted.map((p) => file(p, "conflicted")),
});

describe("buildTree", () => {
  it("compresses single-child chains and sorts directories first", () => {
    const tree = buildTree([file("src/refunds/a.rs"), file("src/refunds/b.rs"), file("README.md"), file("docs/x/y/z.md")]);
    expect(tree.map((n) => (n.kind === "dir" ? `dir:${n.name}` : `file:${n.file.path}`))).toEqual(["dir:docs/x/y", "dir:src/refunds", "file:README.md"]);
    const refunds = tree[1];
    expect(refunds.kind === "dir" && refunds.path).toBe("src/refunds");
    expect(refunds.kind === "dir" && refunds.files.length).toBe(2);
  });

  it("does not merge a directory that also has files", () => {
    const tree = buildTree([file("src/main.rs"), file("src/util/mod.rs")]);
    expect(tree).toHaveLength(1);
    const src = tree[0];
    expect(src.kind === "dir" && src.name).toBe("src");
    expect(src.kind === "dir" && src.children.map((c) => (c.kind === "dir" ? c.name : c.file.path))).toEqual(["util", "src/main.rs"]);
  });
});

describe("buildRows", () => {
  const base = { grouped: true, mode: "tree" as const, collapsed: new Set<string>() };

  it("emits repo, section, dir and file rows in order, conflicts first", () => {
    const rows = buildRows({ ...base, repos: [{ repoId: "r1", wt: wt(["a/x.ts"], ["b.ts"], ["c.ts"]) }] });
    expect(rows.map((r) => r.kind)).toEqual(["repo", "section", "file", "section", "dir", "file", "section", "file"]);
    expect(rows.filter((r) => r.kind === "section").map((r) => (r.kind === "section" ? r.section : ""))).toEqual(["conflicts", "staged", "unstaged"]);
  });

  it("flat mode lists files without directories and skips empty sections", () => {
    const rows = buildRows({ ...base, mode: "flat", grouped: false, repos: [{ repoId: "r1", wt: wt([], ["z/b.ts", "a.ts"]) }] });
    expect(rows.map((r) => r.key)).toEqual([sectionKey("r1", "unstaged"), fileKey("r1", "unstaged", "a.ts"), fileKey("r1", "unstaged", "z/b.ts")]);
  });

  it("hides the children of collapsed repos and sections", () => {
    const repos = [{ repoId: "r1", wt: wt(["a.ts"], ["b.ts"]) }];
    expect(buildRows({ ...base, repos, collapsed: new Set([repoKey("r1")]) }).map((r) => r.kind)).toEqual(["repo"]);
    const rows = buildRows({ ...base, repos, collapsed: new Set([sectionKey("r1", "staged")]) });
    expect(rows.map((r) => r.kind)).toEqual(["repo", "section", "section", "file"]);
  });
});

describe("buildRows by pane", () => {
  const base = { grouped: true, mode: "flat" as const, collapsed: new Set<string>() };
  const repos = [{ repoId: "r1", wt: wt(["s.ts"], ["u.ts"], ["c.ts"]) }, { repoId: "r2", wt: wt(["t.ts"], []) }];

  it("the work pane has the conflicts section and the unstaged files straight under the repo row", () => {
    const rows = buildRows({ ...base, repos, pane: "work" });
    expect(rows.map((r) => r.key)).toEqual([repoKey("r1"), sectionKey("r1", "conflicts"), fileKey("r1", "conflicts", "c.ts"), fileKey("r1", "unstaged", "u.ts")]);
    const repo = rows[0];
    expect(repo.kind === "repo" && repo.count).toBe(2);
  });

  it("the staged pane lists only the repos that have staged files, with their own repo keys", () => {
    const rows = buildRows({ ...base, repos, pane: "staged" });
    expect(rows.map((r) => r.key)).toEqual([repoKey("r1", "staged"), fileKey("r1", "staged", "s.ts"), repoKey("r2", "staged"), fileKey("r2", "staged", "t.ts")]);
    expect(repoKey("r1", "staged")).not.toBe(repoKey("r1", "work"));
  });

  it("a repo without files in a pane has no row there, and an empty pane has no rows at all", () => {
    expect(buildRows({ ...base, repos: [repos[1]], pane: "work" })).toEqual([]);
    expect(buildRows({ ...base, repos: [], pane: "staged" })).toEqual([]);
  });

  it("collapsing a repo in one pane leaves the other pane alone", () => {
    const collapsed = new Set([repoKey("r1")]);
    expect(buildRows({ ...base, repos, collapsed, pane: "work" }).map((r) => r.kind)).toEqual(["repo"]);
    expect(buildRows({ ...base, repos, collapsed, pane: "staged" }).map((r) => r.kind)).toEqual(["repo", "file", "repo", "file"]);
  });

  it("a single repo (not grouped) lists the files without a repo row, at depth 0 in tree mode", () => {
    const rows = buildRows({ grouped: false, mode: "tree", collapsed: new Set(), repos: [repos[0]], pane: "work" });
    expect(rows.map((r) => r.kind)).toEqual(["section", "file", "file"]);
    expect(rows[2].depth).toBe(0);
  });

  it("paneOfKey tells the pane of every kind of key", () => {
    expect(paneOfKey(fileKey("r1", "staged", "a.ts"))).toBe("staged");
    expect(paneOfKey(fileKey("r1", "unstaged", "a.ts"))).toBe("work");
    expect(paneOfKey(fileKey("r1", "conflicts", "a.ts"))).toBe("work");
    expect(paneOfKey(dirKey("r1", "staged", "src"))).toBe("staged");
    expect(paneOfKey(sectionKey("r1", "conflicts"))).toBe("work");
    expect(paneOfKey(repoKey("r1"))).toBe("work");
    expect(paneOfKey(repoKey("r1", "staged"))).toBe("staged");
  });
});

describe("stashFilesOf", () => {
  const item = (repoId: string, section: "staged" | "unstaged" | "conflicts", f: FileChange) => ({ repoId, section, file: f });

  it("collects paths by repo, counts files and untracked files", () => {
    const picks = stashFilesOf([item("r1", "unstaged", file("a.ts")), item("r1", "unstaged", file("n.ts", "untracked")), item("r2", "staged", file("b.ts"))]);
    expect(picks).toEqual({ r1: { paths: ["a.ts", "n.ts"], count: 2, untracked: 1 }, r2: { paths: ["b.ts"], count: 1, untracked: 0 } });
  });

  it("brings the old path of a rename and counts the rename once", () => {
    const renamed: FileChange = { ...file("new.ts", "renamed"), oldPath: "old.ts" };
    expect(stashFilesOf([item("r1", "staged", renamed)])).toEqual({ r1: { paths: ["new.ts", "old.ts"], count: 1, untracked: 0 } });
  });

  it("leaves conflicted files out and counts a file that is in both panes once", () => {
    const picks = stashFilesOf([item("r1", "conflicts", file("c.ts", "conflicted")), item("r1", "staged", file("a.ts")), item("r1", "unstaged", file("a.ts"))]);
    expect(picks).toEqual({ r1: { paths: ["a.ts"], count: 1, untracked: 0 } });
    expect(stashFilesOf([item("r1", "conflicts", file("c.ts", "conflicted"))])).toEqual({});
    expect(stashFilesOf([])).toEqual({});
  });
});

describe("selection helpers", () => {
  const rows: Row[] = buildRows({ grouped: false, mode: "tree", collapsed: new Set(), repos: [{ repoId: "r1", wt: wt([], ["a/1.ts", "a/2.ts", "b.ts"]) }] });

  it("rowItems of a directory are all its files; selectedItems deduplicates", () => {
    const dir = rows.find((r) => r.kind === "dir") as Row;
    expect(rowItems(dir).map((i) => i.file.path)).toEqual(["a/1.ts", "a/2.ts"]);
    const sel = new Set([dir.key, fileKey("r1", "unstaged", "a/1.ts"), fileKey("r1", "unstaged", "b.ts")]);
    expect(selectedItems(rows, sel).map((i) => i.file.path)).toEqual(["a/1.ts", "a/2.ts", "b.ts"]);
  });

  it("rangeKeys skips header rows and works backwards", () => {
    const first = fileKey("r1", "unstaged", "a/1.ts");
    const last = fileKey("r1", "unstaged", "b.ts");
    expect(rangeKeys(rows, last, first)).toEqual([first, fileKey("r1", "unstaged", "a/2.ts"), last]);
    expect(rangeKeys(rows, "nope", first)).toEqual([]);
  });

  it("nearestSurvivor prefers the row below, then above", () => {
    const keys = ["f:1", "f:2", "f:3", "f:4"];
    expect(nearestSurvivor(keys, "f:2", new Set(["f:1", "f:3", "f:4"]))).toBe("f:3");
    expect(nearestSurvivor(keys, "f:4", new Set(["f:1", "f:2"]))).toBe("f:2");
    expect(nearestSurvivor(keys, "f:2", new Set())).toBeNull();
    expect(nearestSurvivor(keys, "gone", new Set(keys))).toBeNull();
    expect(nearestSurvivor(keys, "f:2", new Set(keys), (k) => k !== "f:3")).toBe("f:4");
  });

  it("groupByRepo keeps order", () => {
    const items = [
      { repoId: "a", section: "staged" as const, file: file("1") },
      { repoId: "b", section: "staged" as const, file: file("2") },
      { repoId: "a", section: "staged" as const, file: file("3") },
    ];
    const g = groupByRepo(items);
    expect([...g.keys()]).toEqual(["a", "b"]);
    expect(g.get("a")?.map((i) => i.file.path)).toEqual(["1", "3"]);
  });
});

describe("commit message helpers", () => {
  it("measures the subject line only", () => {
    expect(subjectLength("Fix it\n\nlong body ".repeat(10))).toBe(6);
    expect(subjectLength("")).toBe(0);
    expect(subjectLength("héllo")).toBe(5);
  });
  it("labels the primary button", () => {
    expect(commitLabel(1, false)).toBe("Commit");
    expect(commitLabel(3, false)).toBe("Commit in 3 repos");
    expect(commitLabel(1, true)).toBe("Amend commit");
    expect(commitLabel(2, true)).toBe("Amend commit in 2 repos");
  });
});
