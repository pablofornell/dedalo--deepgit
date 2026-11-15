// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mockInvoke } from "./mock";
import { makePng, mockFileImages, mockImageSide } from "./mockImages";
import type { CommitRow, FileImages, LogSessionInfo, Workspace } from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args) as Promise<T>;

async function gateway() {
  const ws = await call<Workspace>("workspace_load");
  const repo = ws.projects.find((p) => p.name === "payments-platform")?.repos.find((r) => r.name === "api-gateway");
  if (!repo) throw new Error("api-gateway missing");
  const info = await call<LogSessionInfo>("log_open", { query: { repoIds: [repo.id], refs: [], text: "Add idempotency key to refund endpoint" } });
  const [row] = await call<CommitRow[]>("log_rows", { sessionId: info.sessionId, start: 0, count: 1 });
  return { repoId: repo.id, oid: row.oid };
}

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe("mock image files", () => {
  it("makes a valid PNG with the asked size", () => {
    const png = makePng(40, 24, 200);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(40);
    expect(view.getUint32(20)).toBe(24);
    // ends with IEND
    expect(String.fromCharCode(...png.slice(png.length - 8, png.length - 4))).toBe("IEND");
  });

  it("gives the same side for the same seed and a different one for another", () => {
    expect(mockImageSide("a.png", "x")).toEqual(mockImageSide("a.png", "x"));
    expect(mockImageSide("a.png", "x").data).not.toBe(mockImageSide("a.png", "y").data);
    const svg = mockImageSide("a.svg", "x");
    expect(svg.mime).toBe("image/svg+xml");
    expect(new TextDecoder().decode(decode(svg.data ?? ""))).toContain("<svg");
    expect(svg.size).toBe(decode(svg.data ?? "").length);
  });

  it("drops the old side of an added file and the new side of a deleted one", () => {
    expect(mockFileImages("a.png", null, "s", "added").old).toBeNull();
    expect(mockFileImages("a.png", null, "s", "deleted").new).toBeNull();
    const both = mockFileImages("a.png", null, "s", "modified");
    expect(both.old && both.new).toBeTruthy();
  });

  it("answers file_images for the changed, added, deleted and renamed files of a commit", async () => {
    const { repoId, oid } = await gateway();
    const spec = { kind: "commit", oid };
    const get = (path: string, oldPath: string | null = null) => call<FileImages>("file_images", { repoId, spec, path, oldPath });
    const changed = await get("docs/img/refund-flow.png");
    expect(changed.old?.mime).toBe("image/png");
    expect(changed.new?.size).toBeGreaterThan(0);
    expect(changed.new?.tooLarge).toBe(false);
    expect((await get("docs/img/refund-badge.svg")).old).toBeNull();
    expect((await get("docs/img/old-diagram.png")).new).toBeNull();
    const renamed = await get("docs/img/logo.png", "docs/img/brand.png");
    expect(renamed.old).not.toBeNull();
    expect(renamed.new).not.toBeNull();
  });

  it("answers file_images for the working tree and refuses a non-image path", async () => {
    const { repoId } = await gateway();
    const untracked = await call<FileImages>("file_images", { repoId, spec: { kind: "unstaged" }, path: "docs/img/banner.svg", oldPath: null });
    expect(untracked.old).toBeNull();
    expect(untracked.new?.mime).toBe("image/svg+xml");
    await expect(call("file_images", { repoId, spec: { kind: "unstaged" }, path: "src/main.rs", oldPath: null })).rejects.toBeTruthy();
  });

  it("lists the image files as binary (SVG as text) in commit details and the diff", async () => {
    const { repoId, oid } = await gateway();
    const d = await call<{ files: { path: string; binary: boolean }[] }>("commit_details", { repoId, oid });
    expect(d.files.find((f) => f.path === "docs/img/refund-flow.png")?.binary).toBe(true);
    expect(d.files.find((f) => f.path === "docs/img/refund-badge.svg")?.binary).toBe(false);
    const diff = await call<{ binary: boolean }>("file_diff", { repoId, spec: { kind: "commit", oid }, path: "docs/img/refund-flow.png", oldPath: null, context: 3 });
    expect(diff.binary).toBe(true);
  });
});
