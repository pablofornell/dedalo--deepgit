// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseConflicts, resolveAll } from "../features/files/conflictHunks";
import { mockInvoke } from "./mock";
import type { TextFile, Workspace, WorkingTree } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;

async function repoIds() {
  const ws = await call<Workspace>("workspace_load");
  const project = ws.projects.find((p) => p.name === "payments-platform");
  if (!project) throw new Error("project missing");
  const by = (name: string) => (project.repos.find((r) => r.name === name) as { id: string }).id;
  return { docs: by("docs-site"), ledger: by("ledger-service") };
}

const read = (repoId: string, path: string) => call<TextFile>("read_text_file", { repoId, path }).then((f) => f.content);

describe("mock conflicted files on disk", () => {
  it("a merge conflict file holds <<<<<<< blocks and the changes of one side only are already merged", async () => {
    const { docs } = await repoIds();
    const text = await read(docs, "docs/getting-started.md");
    const { hunks, stray } = parseConflicts(text);
    expect(stray).toEqual([]);
    expect(hunks.length).toBeGreaterThan(1);
    expect(hunks[0].oursLabel).toBe("HEAD");
    expect(hunks[0].theirsLabel).toBe("feature/search-docs");
    // Yours changed the install line, theirs added a section: both are in the file without a marker
    expect(text).toContain("npm or pnpm");
    expect(text).toContain("## Search");
    expect(parseConflicts(resolveAll(text, "ours")).hunks).toEqual([]);
  });

  it("a rebase conflict shows the common ancestor and the replayed commit", async () => {
    const { ledger } = await repoIds();
    const { hunks } = parseConflicts(await read(ledger, "src/ledger/posting.rs"));
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks.every((h) => h.base !== null)).toBe(true);
    expect(hunks[0].theirsLabel).toContain("Retry postings on lock timeout");
  });

  it("a modify/delete file keeps the side that is left, without markers", async () => {
    const { docs } = await repoIds();
    const text = await read(docs, "docs/legacy/changelog-2019.md");
    expect(text).toContain("2019-12-30");
    expect(parseConflicts(text).hunks).toEqual([]);
  });

  it("writing the resolved text and staging the file takes it out of the conflicts", async () => {
    const { docs } = await repoIds();
    const path = "config/site.toml";
    const text = await read(docs, path);
    expect(parseConflicts(text).hunks.length).toBeGreaterThan(0);
    const resolved = resolveAll(text, "theirs");
    const f = await call<TextFile>("read_text_file", { repoId: docs, path });
    await call("write_text_file", { repoId: docs, path, content: resolved, expectedVersion: f.version });
    await call("stage", { repoId: docs, paths: [path] });
    const wt = await call<WorkingTree>("working_tree", { repoId: docs });
    expect(wt.conflicted.map((x) => x.path)).not.toContain(path);
    expect(wt.staged.map((x) => x.path)).toContain(path);
    expect(await read(docs, path)).toBe(resolved);
  });

  it("accepting a side writes that version to the file", async () => {
    const { docs } = await repoIds();
    await call("accept_side", { repoId: docs, paths: ["docs/getting-started.md"], side: "theirs" });
    const text = await read(docs, "docs/getting-started.md");
    expect(parseConflicts(text).hunks).toEqual([]);
    expect(text).toContain("Node 22 or newer");
  });
});
