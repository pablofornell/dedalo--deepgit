// @vitest-environment node
// The mock must refuse what the backend refuses: the file commands (crates/gitcore/tests/files.rs mirrors these).
import { describe, expect, it } from "vitest";
import { mockInvoke, mockListen } from "./mock";
import { FIXED_FILES, appendIgnoreLines, byBytes, CHANGED_ON_DISK, ignoredEntries, initialWorktree, isBinary, listFiles, readText, versionOf } from "./mockFiles";
import type { FileList, IgnoreFile, IgnoreTarget, TextFile, Workspace, WorkingTree } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;

/** The rejection of a command; fails the test when the command succeeds. */
async function rejected(p: Promise<unknown>): Promise<{ message: string; detail?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { message: string; detail?: string };
  }
  throw new Error("expected the command to be refused");
}

async function repoNamed(name: string): Promise<string> {
  const ws = await call<Workspace>("workspace_load");
  const repo = ws.projects.flatMap((p) => p.repos).find((r) => r.name === name);
  if (!repo) throw new Error(`no repo ${name}`);
  return repo.id;
}

const write = (repoId: string, path: string, content: string, expectedVersion: string | null = null) =>
  call<string>("write_text_file", { repoId, path, content, expectedVersion });
const read = (repoId: string, path: string) => call<TextFile>("read_text_file", { repoId, path });

describe("mock files: list", () => {
  it("lists the worktree files sorted by bytes and leaves out the ignored ones", async () => {
    const api = await repoNamed("api-gateway");
    const list = await call<FileList>("list_files", { repoId: api });
    expect(list.files).toContain("README.md");
    expect(list.files).toContain("src/main.rs");
    expect(list.files).not.toContain("build.log");
    expect(list.files).not.toContain("dist/bundle.js");
    for (let i = 1; i < list.files.length; i++) expect(byBytes(list.files[i - 1], list.files[i])).toBeLessThan(0);
    expect(list.truncated).toBe(false);
  });

  it("reports the ignored files, and a folder that is ignored as a whole as one entry", async () => {
    const api = await repoNamed("api-gateway");
    const list = await call<FileList>("list_files", { repoId: api });
    expect(list.ignored).toEqual(["build.log", "dist/"]);
  });

  it("gives the outermost folder of ignored files as one entry, whatever the depth", () => {
    const files = new Map([["src/a.rs", ""], ["out/deep/er/1.o", ""], ["out/deep/er/2.o", ""], ["out/deep/3.o", ""]]);
    const ignored = new Set(["out/deep/er/1.o", "out/deep/er/2.o", "out/deep/3.o"]);
    expect(ignoredEntries(files, ignored)).toEqual(["out/"]);
  });

  it("leaves a folder with a tracked file as file entries", () => {
    const files = new Map([["out/keep.o", ""], ["out/x.o", ""]]);
    expect(ignoredEntries(files, new Set(["out/x.o"]))).toEqual(["out/x.o"]);
  });

  it("flags the list as truncated when the ignored entries pass the cap", () => {
    const files = new Map([["a", ""], ["b.o", ""], ["c.o", ""], ["d.o", ""]]);
    const ignored = new Set(["b.o", "c.o", "d.o"]);
    expect(listFiles(files, ignored, 2)).toEqual({ files: ["a"], ignored: ["b.o", "c.o"], truncated: true });
    expect(listFiles(files, ignored, 3).truncated).toBe(false);
  });

  it("keeps an ignored file of a folder with other files as a file entry", () => {
    const files = new Map([["a/keep.rs", ""], ["a/x.log", ""], ["out/b/c.o", ""], ["out/d.o", ""], ["z.log", ""]]);
    const ignored = new Set(["a/x.log", "out/b/c.o", "out/d.o", "z.log"]);
    expect(ignoredEntries(files, ignored)).toEqual(["a/x.log", "out/", "z.log"]);
  });

  it("lists a new file, as the backend lists an untracked one", async () => {
    const api = await repoNamed("api-gateway");
    await write(api, "notes/new-idea.md", "# Idea\n");
    expect((await call<FileList>("list_files", { repoId: api })).files).toContain("notes/new-idea.md");
  });
});

describe("mock files: read", () => {
  it("reads the text with the version that the write returned", async () => {
    const ledger = await repoNamed("ledger-service");
    const version = await write(ledger, "docs/a.txt", "one\r\ntwo\r\n");
    const f = await read(ledger, "docs/a.txt");
    expect(f).toEqual({ content: "one\r\ntwo\r\n", version, binary: false, tooLarge: false });
  });

  it("reads the fixed set of files", async () => {
    const ledger = await repoNamed("ledger-service");
    expect((await read(ledger, "src/main.rs")).content).toBe(FIXED_FILES["src/main.rs"]);
  });

  it("gives no content for a binary file or a file over 2 MiB, and takes exactly 2 MiB", async () => {
    const shared = await repoNamed("shared-proto");
    await write(shared, "bin.dat", "a\u0000b");
    expect(await read(shared, "bin.dat")).toMatchObject({ content: "", binary: true, tooLarge: false });

    const limit = 2 * 1024 * 1024;
    await write(shared, "exact.txt", "a".repeat(limit));
    expect(await read(shared, "exact.txt")).toMatchObject({ tooLarge: false, binary: false });
    await write(shared, "big.txt", "a".repeat(limit + 1));
    expect(await read(shared, "big.txt")).toEqual({ content: "", version: "", binary: false, tooLarge: true });
  });

  it("refuses paths the backend refuses", async () => {
    const ledger = await repoNamed("ledger-service");
    expect(await rejected(read(ledger, "../outside.txt"))).toEqual({ message: "path outside the repo: ../outside.txt" });
    expect(await rejected(read(ledger, "/etc/passwd"))).toEqual({ message: "path outside the repo: /etc/passwd" });
    expect(await rejected(read(ledger, ".git/config"))).toEqual({ message: "path inside the git folder: .git/config" });
    expect(await rejected(read(ledger, ""))).toEqual({ message: "No file path given." });
    expect(await rejected(read(ledger, "src"))).toEqual({ message: "not a regular file: src" });
    expect(await rejected(read(ledger, "nope.md"))).toEqual({ message: "file not found: nope.md" });
  });
});

describe("mock files: write", () => {
  it("refuses a stale version and keeps the saved text", async () => {
    const refunds = await repoNamed("refunds-worker");
    const v1 = await write(refunds, "a.txt", "first");
    const v2 = await write(refunds, "a.txt", "second", v1);
    expect(v2).not.toBe(v1);
    expect(await rejected(write(refunds, "a.txt", "third", v1))).toEqual({ message: CHANGED_ON_DISK });
    expect((await read(refunds, "a.txt")).content).toBe("second");
  });

  it("refuses a missing file when a version is expected", async () => {
    const refunds = await repoNamed("refunds-worker");
    expect(await rejected(write(refunds, "missing.txt", "x", "abc-1"))).toEqual({ message: CHANGED_ON_DISK });
    expect(await rejected(read(refunds, "missing.txt"))).toEqual({ message: "file not found: missing.txt" });
  });

  it("keeps the line endings of the content", async () => {
    const refunds = await repoNamed("refunds-worker");
    await write(refunds, "win.txt", "a\r\nb\r\n");
    expect((await read(refunds, "win.txt")).content).toBe("a\r\nb\r\n");
  });

  it("refuses a folder and paths outside the repo or in the git folder", async () => {
    const refunds = await repoNamed("refunds-worker");
    expect(await rejected(write(refunds, "src", "x"))).toEqual({ message: "not a regular file: src" });
    expect(await rejected(write(refunds, "../x.txt", "x"))).toEqual({ message: "path outside the repo: ../x.txt" });
    expect(await rejected(write(refunds, ".git/hooks/pre-commit", "x"))).toEqual({
      message: "path inside the git folder: .git/hooks/pre-commit",
    });
  });

  it("emits repo-changed after a save, so the UI refreshes", async () => {
    const refunds = await repoNamed("refunds-worker");
    const seen: unknown[] = [];
    const off = mockListen("repo-changed", (p) => seen.push(p));
    await write(refunds, "events.txt", "x");
    await new Promise((r) => setTimeout(r, 250));
    off();
    expect(seen).toContainEqual({ repoId: refunds });
  });
});

const readIgnoreFile = (repoId: string, target: IgnoreTarget) => call<IgnoreFile>("read_ignore_file", { repoId, target });
const readIgnore = async (repoId: string, target: IgnoreTarget) => (await readIgnoreFile(repoId, target)).content;
const append = (repoId: string, target: IgnoreTarget, patterns: string[]) => call<string[]>("append_ignore_rules", { repoId, target, patterns });

describe("mock files: ignore files", () => {
  it("adds a line to .gitignore and hides the untracked file that it matches", async () => {
    const api = await repoNamed("api-gateway");
    const before = await call<WorkingTree>("working_tree", { repoId: api });
    const untracked = before.unstaged.find((f) => f.status === "untracked");
    expect(untracked).toBeDefined();
    const path = untracked?.path ?? "";
    expect((await call<FileList>("list_files", { repoId: api })).files).toContain(path);
    expect(await append(api, "gitignore", [`/${path}`])).toEqual([`/${path}`]);
    expect((await readIgnore(api, "gitignore")).endsWith(`/${path}\n`)).toBe(true);
    expect((await call<FileList>("list_files", { repoId: api })).files).not.toContain(path);
    expect((await call<WorkingTree>("working_tree", { repoId: api })).unstaged.map((f) => f.path)).not.toContain(path);
  });

  it("lists .gitignore as changed after the first change", async () => {
    const web = await repoNamed("web-checkout");
    await append(web, "gitignore", ["*.zzz"]);
    const wt = await call<WorkingTree>("working_tree", { repoId: web });
    expect(wt.unstaged.some((f) => f.path === ".gitignore" && f.status === "modified")).toBe(true);
    // A second change does not list it twice.
    await append(web, "gitignore", ["*.yyy"]);
    const again = await call<WorkingTree>("working_tree", { repoId: web });
    expect(again.unstaged.filter((f) => f.path === ".gitignore")).toHaveLength(1);
  });

  it("writes new lines with the dominant line end and sees a first line behind a byte order mark", () => {
    expect(appendIgnoreLines("a\r\nb\nc\nd\n", ["x/"]).text).toBe("a\r\nb\nc\nd\nx/\n");
    expect(appendIgnoreLines("a\r\nb\r\nc\n", ["x/"]).text).toBe("a\r\nb\r\nc\nx/\r\n");
    expect(appendIgnoreLines("\ufefftarget/\n", ["target/", "y/"])).toEqual({ text: "\ufefftarget/\ny/\n", added: ["y/"] });
  });

  it("skips a line that the file holds already", async () => {
    const ledger = await repoNamed("ledger-service");
    expect(await append(ledger, "gitignore", ["*.log", "gen/"])).toEqual(["gen/"]);
    expect(await append(ledger, "gitignore", ["gen/"])).toEqual([]);
  });

  it("tells the case rule of the repo: the mock repos are case sensitive, like git on Linux", async () => {
    const shared = await repoNamed("shared-proto");
    expect(await readIgnoreFile(shared, "gitignore")).toMatchObject({ ignoreCase: false });
    expect(await readIgnoreFile(shared, "exclude")).toMatchObject({ ignoreCase: false });
  });

  it("keeps the exclude file apart from .gitignore", async () => {
    const shared = await repoNamed("shared-proto");
    expect(await readIgnore(shared, "exclude")).toBe("");
    expect(await append(shared, "exclude", ["/local.env"])).toEqual(["/local.env"]);
    expect(await readIgnore(shared, "exclude")).toBe("/local.env\n");
    expect(await readIgnore(shared, "gitignore")).not.toContain("/local.env");
  });

  it("keeps one global ignore file for every repo, with its path", async () => {
    const a = await repoNamed("refunds-worker");
    const b = await repoNamed("shared-proto");
    const before = await readIgnoreFile(a, "global");
    expect(before.path).toMatch(/\.config\/git\/ignore$/);
    expect(await append(a, "global", ["*.swp"])).toEqual(["*.swp"]);
    // The other repo reads the same file.
    expect(await readIgnore(b, "global")).toBe(before.content + "*.swp\n");
    expect((await readIgnoreFile(b, "global")).path).toBe(before.path);
    expect(await append(b, "global", ["*.swp"])).toEqual([]);
    // The path of the other targets is in the repo.
    expect((await readIgnoreFile(a, "gitignore")).path).toMatch(/\/\.gitignore$/);
    expect((await readIgnoreFile(a, "exclude")).path).toMatch(/\/\.git\/info\/exclude$/);
  });

  it("a global rule hides the untracked files of every repo and tells each one", async () => {
    const writer = await repoNamed("deepgit");
    const other = await repoNamed("api-gateway");
    const wt = await call<WorkingTree>("working_tree", { repoId: other });
    const path = wt.unstaged.find((f) => f.status === "untracked" && f.path.endsWith(".svg"))?.path ?? "";
    expect(path).not.toBe("");
    expect((await call<FileList>("list_files", { repoId: other })).files).toContain(path);
    const seen: string[] = [];
    const off = mockListen("repo-changed", (p) => seen.push((p as { repoId: string }).repoId));
    await append(writer, "global", ["*.svg"]);
    await new Promise((r) => setTimeout(r, 250));
    off();
    expect(seen).toContain(writer);
    expect(seen).toContain(other);
    expect((await call<FileList>("list_files", { repoId: other })).files).not.toContain(path);
  });

  it("gives the global file the lowest priority: .gitignore keeps a file that it re-includes", async () => {
    const repo = await repoNamed("deepgit");
    const wt = await call<WorkingTree>("working_tree", { repoId: repo });
    const path = wt.unstaged.find((f) => f.status === "untracked" && f.path.endsWith(".ts"))?.path ?? "";
    expect(path).not.toBe("");
    // `.gitignore` says `!path`, the global file says `path`: git keeps the file.
    await append(repo, "gitignore", [`!/${path}`]);
    await append(repo, "global", [`/${path}`]);
    expect((await call<FileList>("list_files", { repoId: repo })).files).toContain(path);
    expect((await call<WorkingTree>("working_tree", { repoId: repo })).unstaged.map((f) => f.path)).toContain(path);
    // `.git/info/exclude` comes between: it beats the global file and loses to `.gitignore`.
    await append(repo, "exclude", [`/${path}`]);
    expect((await call<FileList>("list_files", { repoId: repo })).files).toContain(path);
  });

  it("adds templates in the order of the templates", async () => {
    const web = await repoNamed("web-checkout");
    const java = "# --- DeepGit template: Java ---";
    const gradle = "# --- DeepGit template: Gradle ---";
    const order = [java, gradle];
    await call<string[]>("append_ignore_blocks", { repoId: web, target: "exclude", blocks: [{ header: gradle, lines: ["# Wrapper", "!gradle-wrapper.jar"] }], order });
    await call<string[]>("append_ignore_blocks", { repoId: web, target: "exclude", blocks: [{ header: java, lines: ["*.jar"] }], order });
    const text = await readIgnore(web, "exclude");
    expect(text.indexOf(java)).toBeGreaterThan(-1);
    expect(text.indexOf(java)).toBeLessThan(text.indexOf(gradle));
    expect(text.indexOf("*.jar")).toBeLessThan(text.indexOf("!gradle-wrapper.jar"));
  });

  it("adds templates as blocks, once", async () => {
    const web = await repoNamed("shared-proto");
    const blocks = [
      { header: "# --- DeepGit template: Rust ---", lines: ["# Cargo", "target/", "", "*.pdb"] },
      { header: "# --- DeepGit template: Linux ---", lines: ["*~"] },
    ];
    const before = await readIgnore(web, "exclude");
    expect(await call<string[]>("append_ignore_blocks", { repoId: web, target: "exclude", blocks, order: [] })).toEqual(blocks.map((b) => b.header));
    expect(await readIgnore(web, "exclude")).toBe(
      before + (before === "" ? "" : "\n") + "# --- DeepGit template: Rust ---\n# Cargo\ntarget/\n\n*.pdb\n\n# --- DeepGit template: Linux ---\n*~\n",
    );
    expect(await call<string[]>("append_ignore_blocks", { repoId: web, target: "exclude", blocks, order: [] })).toEqual([]);
    expect(await rejected(call("append_ignore_blocks", { repoId: web, target: "exclude", blocks: [{ header: "target/", lines: [] }], order: [] }))).toEqual({
      message: "The header of a block must be a comment.",
    });
    expect((await rejected(call("append_ignore_blocks", { repoId: web, target: "exclude", order: [] }))).message).toContain("missing required key blocks");
    expect((await rejected(call("append_ignore_blocks", { repoId: web, target: "exclude", blocks: [] }))).message).toContain("missing required key order");
  });

  it("refuses an empty pattern, a line break and an unknown target", async () => {
    const refunds = await repoNamed("refunds-worker");
    expect(await rejected(append(refunds, "gitignore", [" "]))).toEqual({ message: "A pattern cannot be empty." });
    expect(await rejected(append(refunds, "gitignore", ["a\nb"]))).toEqual({
      message: "A pattern cannot contain a line break or a NUL character.",
    });
    expect((await rejected(readIgnore(refunds, "nope" as IgnoreTarget))).message).toContain("unknown variant");
    expect((await rejected(call("append_ignore_rules", { repoId: refunds, target: "gitignore" }))).message).toContain("missing required key patterns");
  });

  it("emits repo-changed after a change", async () => {
    const refunds = await repoNamed("refunds-worker");
    const seen: unknown[] = [];
    const off = mockListen("repo-changed", (p) => seen.push(p));
    await append(refunds, "exclude", ["/event.txt"]);
    await new Promise((r) => setTimeout(r, 250));
    off();
    expect(seen).toContainEqual({ repoId: refunds });
  });

  it("appends like the backend: line break first, same line ends, no repeat", () => {
    expect(appendIgnoreLines("", ["a"])).toEqual({ text: "a\n", added: ["a"] });
    expect(appendIgnoreLines("*.log", ["dist/"])).toEqual({ text: "*.log\ndist/\n", added: ["dist/"] });
    expect(appendIgnoreLines("*.log\r\n", ["dist/"])).toEqual({ text: "*.log\r\ndist/\r\n", added: ["dist/"] });
    expect(appendIgnoreLines("a\r\nb\n", ["a", "c", "c"])).toEqual({ text: "a\r\nb\nc\r\n", added: ["c"] });
    expect(appendIgnoreLines("a\n", ["a"])).toEqual({ text: "a\n", added: [] });
  });
});

describe("mock files: rules", () => {
  it("orders by UTF-8 bytes, so U+FFFD comes before an emoji", () => {
    expect(byBytes("�", "\u{1F600}")).toBeLessThan(0);
    expect(byBytes("a", "a")).toBe(0);
    expect(byBytes("Zeta", "src")).toBeLessThan(0);
  });

  it("caps the list and says so", () => {
    const files = new Map([["a", "x"], ["b", "x"], ["c", "x"]]);
    expect(listFiles(files, new Set(), 2)).toEqual({ files: ["a", "b"], ignored: [], truncated: true });
    expect(listFiles(files, new Set(["c"]), 2)).toEqual({ files: ["a", "b"], ignored: ["c"], truncated: false });
  });

  it("makes versions that change with the text and carry its byte length", () => {
    expect(versionOf("abc")).toBe(versionOf("abc"));
    expect(versionOf("abc")).not.toBe(versionOf("abd"));
    expect(versionOf("abc")).toMatch(/-3$/);
    expect(versionOf("é")).toMatch(/-2$/);
  });

  it("detects a NUL byte in the first 8 000 bytes as binary", () => {
    expect(isBinary("a\u0000")).toBe(true);
    expect(isBinary("a".repeat(8000) + "\u0000")).toBe(false);
    expect(readText("a\u0000")).toMatchObject({ content: "", binary: true });
  });

  it("builds the fake disk with the fixed set, the ignored files and the listed paths", () => {
    const { files, ignored } = initialWorktree(["src/scratch/notes_1.rs", "README.md", ".gitignore"]);
    expect(files.has("src/scratch/notes_1.rs")).toBe(true);
    expect(files.get("README.md")).toBe(FIXED_FILES["README.md"]);
    expect(ignored).toEqual(new Set(["dist/bundle.js", "build.log"]));
    expect(files.has("build.log")).toBe(true);
  });
});
