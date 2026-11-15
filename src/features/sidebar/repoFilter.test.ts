// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RepoInfo } from "../../api/types";
import { filterRepoTree, findMatch, normalizeQuery, repoMatches } from "./repoFilter";
import { buildTree, ids, type BuildContext, type SidebarNode } from "./nodes";

const repo = (name: string): RepoInfo => ({ id: name.replace(/\W/g, "_"), name, path: `/w/${name}` });
const ctx: BuildContext = { refsOf: () => undefined, summaryOf: () => undefined, expanded: new Set(), moreOpen: new Set(), query: "" };
const pathOf = (list: RepoInfo[]) => (id: string) => list.find((r) => r.id === id)?.path;

/** "folder(a,b)" / "repo" shape of a tree, to compare structures. */
const shape = (nodes: readonly SidebarNode[]): string[] =>
  nodes.map((n) => (n.kind === "folder" ? `${n.label}(${shape(n.children).join(",")})` : n.kind === "repo" ? n.label : n.kind));

const repos = [repo("services/api"), repo("services/web"), repo("tools/cli"), repo("tools/Café"), repo("docs")];

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

describe("repoMatches", () => {
  it("matches the label or the last segment of the path", () => {
    expect(repoMatches("api", "/w/services/api", "ap")).toBe(true);
    expect(repoMatches("renamed", "/w/old-name", "old")).toBe(true);
    expect(repoMatches("renamed", "C:\\w\\old-name\\", "old")).toBe(true);
  });

  it("does not match the folders above the repo", () => {
    expect(repoMatches("api", "/w/services/api", "services")).toBe(false);
  });
});

describe("filterRepoTree", () => {
  const tree = buildTree(repos, ctx);

  it("returns everything for an empty query", () => {
    expect(filterRepoTree(tree, "", pathOf(repos))).toEqual(tree);
    expect(filterRepoTree(tree, "  ", pathOf(repos))).toEqual(tree);
  });

  it("keeps only the matching repo and the folder above it", () => {
    expect(shape(tree)).toEqual(["services(api,web)", "tools(Café,cli)", "docs"]);
    expect(shape(filterRepoTree(tree, "api", pathOf(repos)))).toEqual(["services(api)"]);
    expect(shape(filterRepoTree(tree, "DOC", pathOf(repos)))).toEqual(["docs"]);
  });

  it("hides a folder with no match inside and keeps a matching one", () => {
    expect(shape(filterRepoTree(tree, "cli", pathOf(repos)))).toEqual(["tools(cli)"]);
    expect(shape(filterRepoTree(tree, "zzz", pathOf(repos)))).toEqual([]);
  });

  it("is case and accent insensitive", () => {
    expect(shape(filterRepoTree(tree, "CAFE", pathOf(repos)))).toEqual(["tools(Café)"]);
    expect(shape(filterRepoTree(tree, "café", pathOf(repos)))).toEqual(["tools(Café)"]);
  });

  it("keeps everything below a folder whose own name matches", () => {
    expect(shape(filterRepoTree(tree, "services", pathOf(repos)))).toEqual(["services(api,web)"]);
  });

  it("keeps matches that sit in several folders, in order", () => {
    expect(shape(filterRepoTree(tree, "e", pathOf(repos)))).toEqual(["services(api,web)", "tools(Café)"]);
  });

  it("matches by the last segment of the path when the label differs", () => {
    const list = [repo("a/one"), repo("a/two"), { id: "r3", name: "b/shown", path: "/w/hidden-dir" }];
    const t = buildTree(list, ctx);
    expect(shape(filterRepoTree(t, "hidden", pathOf(list)))).toEqual(["shown"]);
  });

  it("does not change the original tree", () => {
    const before = JSON.stringify(tree);
    filterRepoTree(tree, "api", pathOf(repos));
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("keeps a repo that only holds a matching nested repo, without its branches", () => {
    const list = [repo("mono"), { id: "inner", name: "mono/libs/inner", path: "/w/mono/libs/inner" }, repo("other")];
    const t = buildTree(list, { ...ctx, expanded: new Set([ids.repo("mono")]), refsOf: () => ({ local: [], remote: [], tags: [], stashes: [], remotes: [], submodules: [] }) });
    const out = filterRepoTree(t, "inner", pathOf(list));
    expect(shape(out)).toEqual(["mono"]);
    expect(shape(out[0].children ?? [])).toEqual(["inner"]);
  });

  it("keeps the branches of a repo that matches itself", () => {
    const list = [repo("mono"), { id: "inner", name: "mono/inner", path: "/w/mono/inner" }];
    const t = buildTree(list, ctx);
    const out = filterRepoTree(t, "mono", pathOf(list));
    expect(out).toEqual(t);
  });
});
