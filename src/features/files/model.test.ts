// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FileChange, WorkingTree } from "../../api/types";
import {
  SEP, buildTree, checkNewName, closeTab, columnOffset, dirNodeStatus, draftNode, emptyFolders, errorText, fileNodeStatus, folderChain, folderStatus, folderStatuses,
  goneFolders, groupHits, isStaleVersion, knownEntries, lineSeparatorOf, matchRange, newEntryDir, openTab, rankFiles, repoNode, revealIds, scopeId, statusMap, tabLabels, tabsToClose,
  withDraft, type DirNode, type RepoNode, type TreeNode,
} from "./model";

const change = (path: string, status: FileChange["status"]): FileChange => ({ path, oldPath: null, status, additions: 0, deletions: 0, binary: false });

const wt = (o: Partial<Omit<WorkingTree, "repoId">>): WorkingTree => ({ repoId: "r", staged: [], unstaged: [], conflicted: [], ...o });

describe("buildTree", () => {
  it("nests files under their folders and keeps the full path as the id", () => {
    const t = buildTree(["src/app/main.ts", "README.md"]);
    expect(t.map((n) => n.name)).toEqual(["src", "README.md"]);
    const src = t[0] as DirNode;
    expect(src.id).toBe("src/");
    expect(src.path).toBe("src/");
    const app = src.children[0] as DirNode;
    expect(app.id).toBe("src/app/");
    expect(app.children[0]).toMatchObject({ kind: "file", id: "src/app/main.ts", path: "src/app/main.ts", name: "main.ts" });
  });

  it("lists folders first, then names case-insensitively in natural order", () => {
    const t = buildTree(["z.md", "B/x", "a.rs", "A/y", "file10.rs", "file2.rs", "Zeta/q"]);
    expect(t.map((n) => n.name)).toEqual(["A", "B", "Zeta", "a.rs", "file2.rs", "file10.rs", "z.md"]);
  });

  it("sorts the children of a folder too", () => {
    const t = buildTree(["d/b.txt", "d/A.txt", "d/sub/x"]);
    const d = t[0] as DirNode;
    expect(d.children.map((n) => n.name)).toEqual(["sub", "A.txt", "b.txt"]);
  });

  it("scopes the ids with the repo id and gives the same path two ids in two repos", () => {
    const a = buildTree(["README.md", "src/x.ts"], "repoA");
    const b = buildTree(["README.md"], "repoB");
    // folders first: src/ is the first node, README.md the second
    expect(a[0].id).toBe("repoA" + SEP + "src/");
    expect(a[1].id).toBe("repoA" + SEP + "README.md");
    expect(a[1].repoId).toBe("repoA");
    expect(b[0].id).not.toBe(a[1].id);
    expect((a[0] as DirNode).children[0].id).toBe("repoA" + SEP + "src/x.ts");
  });

  it("shows a path that ends with a slash as a folder without children", () => {
    const t = buildTree(["src/a.ts", "node_modules/", "out/cache/"]);
    expect(t.map((n) => n.name)).toEqual(["node_modules", "out", "src"]);
    expect(t[0]).toMatchObject({ kind: "dir", id: "node_modules/", path: "node_modules/", children: [] });
    const out = t[1] as DirNode;
    expect(out.children).toMatchObject([{ kind: "dir", path: "out/cache/", children: [] }]);
  });

  it("returns nothing for an empty list", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("wraps one repo in a repo node", () => {
    const r = repoNode("r1", "api", ["a.ts"]);
    expect(r).toMatchObject({ kind: "repo", id: "r1" + SEP, repoId: "r1", name: "api" });
    expect(r.children[0]).toMatchObject({ kind: "file", id: scopeId("r1", "a.ts") });
  });

  it("scopes ids only when a repo id is given", () => {
    expect(scopeId("", "a/b")).toBe("a/b");
    expect(scopeId("r", "a/b")).toBe("r" + SEP + "a/b");
  });
});

describe("statusMap", () => {
  it("takes conflicted over unstaged over staged", () => {
    const m = statusMap(
      wt({
        staged: [change("a.ts", "added"), change("b.ts", "modified"), change("c.ts", "modified")],
        unstaged: [change("b.ts", "deleted"), change("d.ts", "untracked")],
        conflicted: [change("c.ts", "conflicted")],
      }),
    );
    expect(m.get("a.ts")).toBe("added");
    expect(m.get("b.ts")).toBe("deleted");
    expect(m.get("c.ts")).toBe("conflicted");
    expect(m.get("d.ts")).toBe("untracked");
    expect(m.size).toBe(4);
  });

  it("is empty for a clean tree", () => {
    expect(statusMap(wt({})).size).toBe(0);
  });
});

describe("folderStatuses and folderStatus", () => {
  const folders = (files: [string, Parameters<typeof change>[1]][]) => folderStatuses(new Map(files));

  it("marks every ancestor folder of a changed file", () => {
    const f = folders([["a/b/c.ts", "modified"]]);
    expect([...f.keys()].sort()).toEqual(["a/", "a/b/"]);
  });

  it("shows conflicted when any file below is conflicted", () => {
    const f = folders([["a/x.ts", "modified"], ["a/y.ts", "conflicted"]]);
    expect(folderStatus("a/", f)).toBe("conflicted");
  });

  it("shows modified when a tracked file below changed", () => {
    const f = folders([["a/x.ts", "untracked"], ["a/b/y.ts", "deleted"]]);
    expect(folderStatus("a/", f)).toBe("modified");
    expect(folderStatus("a/b/", f)).toBe("modified");
  });

  it("shows untracked when every changed file below is untracked", () => {
    const f = folders([["a/x.ts", "untracked"], ["a/b/y.ts", "untracked"]]);
    expect(folderStatus("a/", f)).toBe("untracked");
    expect(folderStatus("a/b", f)).toBe("untracked");
  });

  it("is null for a folder without changes", () => {
    const f = folders([["a/x.ts", "modified"]]);
    expect(folderStatus("z/", f)).toBeNull();
    expect(folderStatus("a", f)).toBe("modified");
  });

  it("gives no folder for a file at the root", () => {
    expect(folders([["README.md", "modified"]]).size).toBe(0);
  });
});

describe("fileNodeStatus and dirNodeStatus", () => {
  const files = new Map<string, Parameters<typeof change>[1]>([["a/x.ts", "modified"], ["kept.log", "modified"]]);
  const folders = folderStatuses(files);
  const ignored = new Set(["build.log", "kept.log", "dist/", "a/gen/"]);

  it("shows the change of a file, and ignored for an ignored file without a change", () => {
    expect(fileNodeStatus("a/x.ts", files, ignored)).toBe("modified");
    expect(fileNodeStatus("build.log", files, ignored)).toBe("ignored");
    expect(fileNodeStatus("a/y.ts", files, ignored)).toBeNull();
  });

  it("lets the change of a tracked file win over an ignore rule", () => {
    expect(fileNodeStatus("kept.log", files, ignored)).toBe("modified");
  });

  it("shows an ignored folder as ignored, with or without the trailing slash", () => {
    expect(dirNodeStatus("dist/", folders, ignored)).toBe("ignored");
    expect(dirNodeStatus("dist", folders, ignored)).toBe("ignored");
  });

  it("colours a folder only from its changed files, and an ignored file adds nothing", () => {
    expect(dirNodeStatus("a/", folders, ignored)).toBe("modified");
    expect(dirNodeStatus("b/", folders, ignored)).toBeNull();
    // `build.log` is ignored and its folder (the root) has no key, so nothing colours
    expect(folders.size).toBe(1);
  });
});

describe("groupHits", () => {
  it("groups by file in path order and keeps the hit order", () => {
    const hits = [
      { path: "src/b.ts", line: 1 },
      { path: "docs/a.md", line: 9 },
      { path: "src/b.ts", line: 4 },
      { path: "src/a.ts", line: 2 },
    ];
    const groups = groupHits(hits);
    expect(groups.map((g) => g.path)).toEqual(["docs/a.md", "src/a.ts", "src/b.ts"]);
    expect(groups[2].hits.map((h) => h.line)).toEqual([1, 4]);
  });

  it("returns nothing for no hits", () => {
    expect(groupHits([])).toEqual([]);
  });
});

describe("revealIds", () => {
  it("lists every folder above the file", () => {
    expect(revealIds("r", "src/app/main.ts", false)).toEqual(["r" + SEP + "src/", "r" + SEP + "src/app/"]);
  });

  it("adds the repo root when the tree has one root for each repo", () => {
    expect(revealIds("r", "src/main.ts", true)).toEqual(["r" + SEP, "r" + SEP + "src/"]);
    expect(revealIds("r", "README.md", true)).toEqual(["r" + SEP]);
  });

  it("is empty for a root file in a tree without repo roots", () => {
    expect(revealIds("r", "README.md", false)).toEqual([]);
  });
});

describe("lineSeparatorOf", () => {
  it("is CRLF only when the content has a CRLF", () => {
    expect(lineSeparatorOf("a\r\nb")).toBe("\r\n");
    expect(lineSeparatorOf("a\nb")).toBe("\n");
    expect(lineSeparatorOf("a\rb")).toBe("\n");
    expect(lineSeparatorOf("")).toBe("\n");
  });
});

describe("tab helpers", () => {
  it("opens a key once and returns it as the active key", () => {
    const tabs = ["a"];
    expect(openTab(tabs, "b")).toBe("b");
    expect(openTab(tabs, "a")).toBe("a");
    expect(tabs).toEqual(["a", "b"]);
  });

  it("activates the right neighbour when the active tab closes", () => {
    const tabs = ["a", "b", "c"];
    expect(closeTab(tabs, "b", "b")).toBe("c");
    expect(tabs).toEqual(["a", "c"]);
  });

  it("falls back to the left neighbour when the last tab closes", () => {
    const tabs = ["a", "b", "c"];
    expect(closeTab(tabs, "c", "c")).toBe("b");
    expect(tabs).toEqual(["a", "b"]);
  });

  it("returns null when the only tab closes", () => {
    const tabs = ["a"];
    expect(closeTab(tabs, "a", "a")).toBeNull();
    expect(tabs).toEqual([]);
  });

  it("keeps the active tab when another tab closes", () => {
    const tabs = ["a", "b", "c"];
    expect(closeTab(tabs, "a", "c")).toBe("c");
    expect(tabs).toEqual(["b", "c"]);
  });

  it("keeps the active tab when a key that is not open closes", () => {
    const tabs = ["a"];
    expect(closeTab(tabs, "zz", "a")).toBe("a");
    expect(tabs).toEqual(["a"]);
  });

  describe("tabsToClose", () => {
    const order = ["a", "b", "c", "d"];

    it("closes this tab, the other tabs or all tabs", () => {
      expect(tabsToClose(order, "b", "this")).toEqual(["b"]);
      expect(tabsToClose(order, "b", "others")).toEqual(["a", "c", "d"]);
      expect(tabsToClose(order, "b", "all")).toEqual(["a", "b", "c", "d"]);
    });

    it("closes the tabs on one side, in tab order", () => {
      expect(tabsToClose(order, "c", "left")).toEqual(["a", "b"]);
      expect(tabsToClose(order, "c", "right")).toEqual(["d"]);
    });

    it("closes nothing on the side of the first and the last tab", () => {
      expect(tabsToClose(order, "a", "left")).toEqual([]);
      expect(tabsToClose(order, "d", "right")).toEqual([]);
      expect(tabsToClose(["a"], "a", "others")).toEqual([]);
    });

    it("closes nothing for a tab that is not open, and does not change the list", () => {
      expect(tabsToClose(order, "zz", "all")).toEqual([]);
      expect(order).toEqual(["a", "b", "c", "d"]);
    });
  });

  it("adds the parent folder only to tabs with the same file name", () => {
    expect(tabLabels(["src/a/index.ts", "src/b/index.ts", "README.md"])).toEqual([
      { name: "index.ts", hint: "a" },
      { name: "index.ts", hint: "b" },
      { name: "README.md", hint: "" },
    ]);
  });

  it("gives no hint for a root file with a clashing name", () => {
    expect(tabLabels(["x.ts", "dir/x.ts"])).toEqual([
      { name: "x.ts", hint: "" },
      { name: "x.ts", hint: "dir" },
    ]);
  });

  it("uses the root hint (the repo name) for root files with a clashing name, and the folder when there is one", () => {
    expect(tabLabels(["README.md", "README.md", "docs/README.md"], ["api", "ledger", "ignored"])).toEqual([
      { name: "README.md", hint: "api" },
      { name: "README.md", hint: "ledger" },
      { name: "README.md", hint: "docs" },
    ]);
  });
});

describe("columnOffset and matchRange", () => {
  it("counts characters, not UTF-16 units", () => {
    // "😀" takes two UTF-16 units but one character
    expect(columnOffset("😀a", 2)).toBe(2);
    expect(columnOffset("abc", 1)).toBe(0);
    expect(columnOffset("abc", 99)).toBe(3);
  });

  it("finds a plain match, case-insensitively unless asked", () => {
    expect(matchRange("say Hello", 5, "hello", { caseSensitive: false, regex: false })).toEqual({ from: 4, to: 9 });
    expect(matchRange("say Hello", 5, "hello", { caseSensitive: true, regex: false })).toEqual({ from: 4, to: 4 });
  });

  it("finds a regex match at the column", () => {
    expect(matchRange("x = 12 + 345", 5, "\\d+", { caseSensitive: false, regex: true })).toEqual({ from: 4, to: 6 });
  });

  it("gives an empty range when the match cannot be checked", () => {
    expect(matchRange("abc", 1, "[", { caseSensitive: false, regex: true })).toEqual({ from: 0, to: 0 });
    expect(matchRange("abc", 1, "zzz", { caseSensitive: false, regex: false })).toEqual({ from: 0, to: 0 });
    expect(matchRange("abc", 1, "", { caseSensitive: false, regex: false })).toEqual({ from: 0, to: 0 });
  });
});

describe("rankFiles", () => {
  const paths = ["src/main.rs", "src/features/log/LogView.tsx", "README.md", "docs/guide.md"];

  it("keeps the order and caps the rows for an empty query", () => {
    expect(rankFiles("", paths, (p) => p, 2).map((r) => r.item)).toEqual(["src/main.rs", "src/features/log/LogView.tsx"]);
  });

  it("drops the files that do not match and puts file-name matches first", () => {
    const out = rankFiles("guide", paths, (p) => p);
    expect(out.map((r) => r.item)).toEqual(["docs/guide.md"]);
    const logs = rankFiles("logview", paths, (p) => p);
    expect(logs[0].item).toBe("src/features/log/LogView.tsx");
    expect(logs[0].positions.length).toBeGreaterThan(0);
  });

  it("uses the item's path through pathOf", () => {
    const items = [{ path: "a/zeta.ts" }, { path: "b/alpha.ts" }];
    expect(rankFiles("alpha", items, (i) => i.path).map((r) => r.item.path)).toEqual(["b/alpha.ts"]);
  });
});

describe("error and stale-version helpers", () => {
  it("reads the message of a rejection object or a plain value", () => {
    expect(errorText({ message: "boom" })).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(new Error("bad"))).toBe("bad");
  });

  it("recognises the changed-on-disk message", () => {
    expect(isStaleVersion("The file changed on disk. Reload it before you save.")).toBe(true);
    expect(isStaleVersion("Permission denied")).toBe(false);
  });
});

describe("new file or folder: where the draft row goes", () => {
  const names = (list: readonly TreeNode[]) => list.map((n) => (n.kind === "draft" ? "<draft>" : n.kind === "repo" ? n.name : n.name));
  const tree = () => buildTree(["src/app/main.ts", "src/lib.rs", "docs/", "README.md", "zeta.txt"], "r1");

  it("finds the folder of the node that was clicked", () => {
    const t = buildTree(["src/app/main.ts", "README.md"], "r1");
    const src = t[0] as DirNode;
    expect(newEntryDir(src)).toBe("src/");
    expect(newEntryDir(src.children[0])).toBe("src/app/");
    expect(newEntryDir((src.children[0] as DirNode).children[0])).toBe("src/app/");
    expect(newEntryDir(t[1])).toBe("");
    expect(newEntryDir(repoNode("r1", "one", []))).toBe("");
  });

  it("puts a new file first among the files and a new folder first among the folders", () => {
    expect(names(withDraft(tree(), draftNode("r1", "", false)))).toEqual(["docs", "src", "<draft>", "README.md", "zeta.txt"]);
    expect(names(withDraft(tree(), draftNode("r1", "", true)))).toEqual(["<draft>", "docs", "src", "README.md", "zeta.txt"]);
  });

  it("puts the draft in a nested folder and leaves the other nodes alone", () => {
    const before = tree();
    const out = withDraft(before, draftNode("r1", "src/app/", false));
    const src = out.find((n) => n.kind === "dir" && n.name === "src") as DirNode;
    const app = src.children.find((n) => n.name === "app") as DirNode;
    expect(names(app.children)).toEqual(["<draft>", "main.ts"]);
    expect(out.find((n) => n.kind === "dir" && n.name === "docs")).toBe(before.find((n) => n.kind === "dir" && n.name === "docs"));
    // The input tree is not changed.
    expect(names((before[1] as DirNode).children)).toEqual(["app", "lib.rs"]);
  });

  it("puts the draft in an empty folder, which gets a child", () => {
    const out = withDraft(tree(), draftNode("r1", "docs/", false));
    expect(names((out[0] as DirNode).children)).toEqual(["<draft>"]);
  });

  it("puts the draft in the repo that owns it in a multi-repo tree", () => {
    const roots: TreeNode[] = [repoNode("a", "alpha", ["x.ts"]), repoNode("b", "beta", ["y/z.ts"])];
    const out = withDraft(roots, draftNode("b", "y/", true));
    expect(names((out[0] as RepoNode).children)).toEqual(["x.ts"]);
    const beta = out[1] as RepoNode;
    expect(names((beta.children[0] as DirNode).children)).toEqual(["<draft>", "z.ts"]);
    expect(names((withDraft(roots, draftNode("a", "", false))[0] as RepoNode).children)).toEqual(["<draft>", "x.ts"]);
  });

  it("shows no draft when its folder is not in the tree", () => {
    expect(names(withDraft(tree(), draftNode("r1", "gone/", false)))).toEqual(["docs", "src", "README.md", "zeta.txt"]);
  });

  it("gives each draft an id that no file has", () => {
    const a = draftNode("r1", "", false);
    expect(a.id).not.toBe(draftNode("r1", "src/", false).id);
    expect(a.id).not.toBe(scopeId("r1", ""));
  });
});

describe("new file or folder: the name", () => {
  const known = knownEntries(["src/main.rs", "src/app/view.ts", "README.md", "dist/", "empty/"]);
  const path = (raw: string, dir = "", isDir = false) => checkNewName(raw, dir, isDir, known);

  it("accepts a plain name and a nested path, in the folder given", () => {
    expect(path("notes.txt")).toEqual({ path: "notes.txt" });
    expect(path("a/b/c.txt")).toEqual({ path: "a/b/c.txt" });
    expect(path("new.rs", "src/")).toEqual({ path: "src/new.rs" });
    expect(path("  spaced.txt  ")).toEqual({ path: "spaced.txt" });
    expect(path("sub/deeper", "src/", true)).toEqual({ path: "src/sub/deeper" });
  });

  it("lets a new folder end with a slash and refuses that for a file", () => {
    expect(path("lib/", "", true)).toEqual({ path: "lib" });
    expect(path("lib/")).toEqual({ error: "A name cannot start or end with / or have an empty part." });
  });

  it("refuses an empty name", () => {
    expect(path("")).toEqual({ error: "Enter a name." });
    expect(path("   ")).toEqual({ error: "Enter a name." });
    expect(path("/", "", true)).toEqual({ error: "Enter a name." });
  });

  it("refuses a backslash, a control character and empty parts", () => {
    expect(path("a\\b")).toMatchObject({ error: expect.stringContaining("backslash") });
    expect(path("a\u0000b")).toMatchObject({ error: expect.stringContaining("control") });
    expect(path("a\tb")).toMatchObject({ error: expect.stringContaining("control") });
    expect(path("/abs.txt")).toMatchObject({ error: expect.stringContaining("empty part") });
    expect(path("a//b.txt")).toMatchObject({ error: expect.stringContaining("empty part") });
  });

  it("refuses . and .. as a part, so the path cannot leave the repo", () => {
    expect(path("..")).toEqual({ error: '".." is not allowed in a name.' });
    expect(path("../x.txt")).toEqual({ error: '".." is not allowed in a name.' });
    expect(path("a/../../x")).toEqual({ error: '".." is not allowed in a name.' });
    expect(path("./x.txt")).toEqual({ error: '"." is not allowed in a name.' });
  });

  it("refuses .git in any case, at any depth", () => {
    for (const name of [".git", ".GIT/hooks", "a/.git/x", ".Git"]) expect(path(name)).toEqual({ error: "A new entry cannot go inside .git." });
    // A name that only starts with .git is fine.
    expect(path(".gitkeep")).toEqual({ path: ".gitkeep" });
    expect(path(".github/workflows/ci.yml")).toEqual({ path: ".github/workflows/ci.yml" });
  });

  it("refuses names that Windows reads as .git, stream names and parts that end with a dot or a space", () => {
    for (const name of [".git.", ".git ", ".GIT. .", "a/.Git../x", "git~1", "GIT~1/x", "a/git~2"]) {
      expect(path(name)).toEqual({ error: "A new entry cannot go inside .git." });
    }
    expect(path("a:b")).toEqual({ error: 'A name cannot contain ":".' });
    expect(path("a::$DATA")).toEqual({ error: 'A name cannot contain ":".' });
    expect(path("x./y")).toEqual({ error: "A part of a name cannot end with a dot or a space." });
    expect(path("x /y")).toEqual({ error: "A part of a name cannot end with a dot or a space." });
    expect(path("end.")).toEqual({ error: "A part of a name cannot end with a dot or a space." });
    // A dot or a space inside a part is fine, and so is a name that only holds "git".
    expect(path("a.b c.txt")).toEqual({ path: "a.b c.txt" });
    expect(path("gitignore~")).toEqual({ path: "gitignore~" });
  });

  it("refuses a name that exists: a file, a folder, an ignored folder or an empty one", () => {
    expect(path("README.md")).toEqual({ error: '"README.md" already exists here.' });
    expect(path("main.rs", "src/")).toEqual({ error: '"main.rs" already exists here.' });
    expect(path("src")).toEqual({ error: '"src" already exists here.' });
    expect(path("app", "src/", true)).toEqual({ error: '"app" already exists here.' });
    expect(path("dist", "", true)).toEqual({ error: '"dist" already exists here.' });
    expect(path("empty")).toEqual({ error: '"empty" already exists here.' });
    expect(path("src/main.rs")).toEqual({ error: '"src/main.rs" already exists here.' });
  });

  it("refuses a path that goes through a file", () => {
    expect(path("README.md/x.txt")).toEqual({ error: '"README.md" is a file, so nothing can go inside it.' });
    expect(path("main.rs/deep/x", "src/")).toEqual({ error: '"src/main.rs" is a file, so nothing can go inside it.' });
  });

  it("is case sensitive: the disk decides on a case-insensitive file system", () => {
    expect(path("readme.md")).toEqual({ path: "readme.md" });
  });
});

describe("new file or folder: the entries that exist", () => {
  it("reads every folder above a path, and a path with a trailing slash as a folder", () => {
    const k = knownEntries(["a/b/c.txt", "d.txt", "out/"]);
    expect([...k.files].sort()).toEqual(["a/b/c.txt", "d.txt"]);
    expect([...k.dirs].sort()).toEqual(["a", "a/b", "out"]);
  });

  it("lists the folders that a path makes", () => {
    expect(folderChain("a/b/c.txt")).toEqual(["a/", "a/b/"]);
    expect(folderChain("c.txt")).toEqual([]);
    expect(folderChain("a/b/")).toEqual(["a/", "a/b/"]);
  });

  it("keeps a new folder until a file lies in it", () => {
    const dirs = new Set(["docs/", "src/new/", "src/"]);
    expect([...emptyFolders(dirs, ["src/new/a.ts", "x.ts"])].sort()).toEqual(["docs/"]);
    expect([...emptyFolders(dirs, ["src/a.ts"])].sort()).toEqual(["docs/", "src/new/"]);
    expect(emptyFolders(new Set(), ["a"]).size).toBe(0);
  });

  it("drops a new folder that is gone from the disk and has nothing inside", () => {
    const dirs = new Set(["docs/", "src/", "src/new/"]);
    // docs/ and src/new/ are not on the disk any more. src/ is.
    const gone = goneFolders(dirs, new Set(["src/"]), ["README.md"]);
    expect([...gone].sort()).toEqual(["docs/", "src/new/"]);
    expect([...emptyFolders(dirs, ["README.md"], gone)]).toEqual(["src/"]);
    // A folder with an entry inside is not gone, even when the disk check missed it. An ignored folder entry counts too.
    expect(goneFolders(dirs, new Set(), ["docs/a.md", "src/new/cache/"]).size).toBe(0);
    expect(goneFolders(new Set(), new Set(), []).size).toBe(0);
  });
});
