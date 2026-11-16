// The focused repo is kept per project: a project switch brings back the repo the user left focused there
// (bug: the switch focused the first repo of the new project, and the sidebar opened it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusKey, resolveFocus } from "./projectFocus";

describe("resolveFocus", () => {
  const repos = ["a", "b", "c"];

  it("keeps the repo focused now when it belongs to the project", () => {
    expect(resolveFocus(repos, "b", "c")).toBe("b");
  });

  it("brings back the saved repo when the current one is from another project", () => {
    expect(resolveFocus(repos, "x-from-other-project", "c")).toBe("c");
    expect(resolveFocus(repos, null, "c")).toBe("c");
  });

  it("falls back to the first repo only when nothing valid is saved", () => {
    expect(resolveFocus(repos, null, null)).toBe("a");
    expect(resolveFocus(repos, null, "gone")).toBe("a");
    expect(resolveFocus(repos, null, 42)).toBe("a");
  });

  it("is null for a project without repos", () => {
    expect(resolveFocus([], "a", "a")).toBeNull();
  });

  it("keys the saved repo by project", () => {
    expect(focusKey("p1")).toBe("focusedRepo.p1");
    expect(focusKey(null)).toBe("focusedRepo.none");
  });
});

describe("switching project", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("gives back the repo each project had focused, and saves nothing for a project the user did not touch", async () => {
    const ws = await import("./workspace");
    await ws.loadWorkspace();
    const first = ws.workspace.projects.find((p) => p.id === "p-payments")!;
    const second = ws.workspace.projects.find((p) => p.id === "p-deepgit")!;
    await ws.setActiveProject(first.id);
    const firstRepos = ws.projectRepos();
    expect(firstRepos.length).toBeGreaterThan(2);
    const picked = firstRepos[2];
    ws.setFocusedRepoId(picked.id);

    await ws.setActiveProject(second.id);
    // the first repo of the second project is only the fallback: it is not saved as a choice
    expect(ws.focusedRepo()?.id).toBe(ws.projectRepos()[0].id);
    expect(store.has("deepgit.ui." + focusKey(second.id))).toBe(false);

    await ws.setActiveProject(first.id);
    expect(ws.focusedRepo()?.id).toBe(picked.id);
    expect(ws.focusedRepoIdSignal()).toBe(picked.id);
  });
});
