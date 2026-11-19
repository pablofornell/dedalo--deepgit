// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSelection, commitFor, detailsCommit, detailsTab, detailsTabFor, fileFor, selectFile, selectedCommit, selectedFile, setDetailsTab, setMainTab, setSelectedCommit,
} from "./selection";

const a = { repoId: "r1", oid: "aaa" };
const b = { repoId: "r1", oid: "bbb" };

describe("setSelectedCommit and the right column tab", () => {
  beforeEach(() => clearSelection());

  it("returns to Changed files when File changes has no file", () => {
    setSelectedCommit(a);
    setDetailsTab("diff");
    setSelectedCommit(b);
    expect(detailsTab()).toBe("files");
  });
  it("keeps File changes when a file is open (CommitDetails follows or drops it)", () => {
    setSelectedCommit(a);
    selectFile({ repoId: "r1", spec: { kind: "commit", oid: "aaa", parent: null }, path: "x" });
    expect(detailsTab()).toBe("diff");
    setSelectedCommit(b);
    expect(detailsTab()).toBe("diff");
  });
  it("does not change the tab when the same commit is selected again", () => {
    setSelectedCommit(a);
    setDetailsTab("diff");
    setSelectedCommit(a);
    expect(detailsTab()).toBe("diff");
  });
});

describe("each main tab owns its right column", () => {
  const logFile = { repoId: "r1", spec: { kind: "commit" as const, oid: "aaa", parent: null }, path: "x" };
  const wtFile = { repoId: "r1", spec: { kind: "unstaged" as const }, path: "y" };
  const stash = { repoId: "r1", oid: "sss", stash: { index: 0 } };

  beforeEach(() => {
    clearSelection();
    setMainTab("log");
  });

  it("shows nothing on Local changes for a commit and file opened on Log", () => {
    setSelectedCommit(a);
    selectFile(logFile);
    expect(detailsTab()).toBe("diff");
    setMainTab("changes");
    expect(selectedFile()).toBeNull();
    expect(detailsTab()).toBe("files");
    expect(detailsCommit()).toBeNull();
    expect(selectedCommit()).toEqual(a);
  });
  it("restores the file and the column tab of each main tab", () => {
    setSelectedCommit(a);
    selectFile(logFile);
    setMainTab("changes");
    selectFile(wtFile);
    expect(selectedFile()).toEqual(wtFile);
    expect(detailsTab()).toBe("diff");
    setMainTab("log");
    expect(selectedFile()).toEqual(logFile);
    expect(detailsTab()).toBe("diff");
    expect(detailsCommit()).toEqual(a);
    setDetailsTab("files");
    setMainTab("changes");
    expect(detailsTab()).toBe("diff");
    expect(detailsTabFor("log")).toBe("files");
  });
  it("writes the Local changes file with an explicit tab while Log is active (re-point after a stage)", () => {
    setSelectedCommit(a);
    selectFile(logFile);
    selectFile(wtFile, { tab: "changes" });
    selectFile({ ...wtFile, spec: { kind: "staged" } }, { reveal: false, tab: "changes" });
    expect(selectedFile()).toEqual(logFile);
    expect(fileFor("changes")).toEqual({ ...wtFile, spec: { kind: "staged" } });
    setDetailsTab("files", "changes");
    expect(detailsTab()).toBe("diff");
    expect(detailsTabFor("changes")).toBe("files");
  });
  it("keeps the Log commit when a stash is shown on Local changes", () => {
    setSelectedCommit(a);
    setMainTab("changes");
    setSelectedCommit(stash, { tab: "changes" });
    expect(selectedCommit()).toEqual(a);
    expect(detailsCommit()).toEqual(stash);
    expect(commitFor("changes")).toEqual(stash);
    setMainTab("log");
    expect(detailsCommit()).toEqual(a);
  });
  it("drops a stash file on Local changes when the stash goes, and keeps the Log file", () => {
    setSelectedCommit(a);
    selectFile(logFile);
    setMainTab("changes");
    setSelectedCommit(stash, { tab: "changes" });
    selectFile({ repoId: "r1", spec: { kind: "commit", oid: "sss", parent: null }, path: "z" });
    setSelectedCommit(null, { tab: "changes" });
    expect(selectedFile()).toBeNull();
    expect(detailsTab()).toBe("files");
    expect(fileFor("log")).toEqual(logFile);
  });
  it("clearSelection clears both main tabs", () => {
    setSelectedCommit(a);
    selectFile(logFile);
    setSelectedCommit(stash, { tab: "changes" });
    selectFile(wtFile, { tab: "changes" });
    clearSelection();
    for (const t of ["log", "changes"] as const) {
      expect(commitFor(t)).toBeNull();
      expect(fileFor(t)).toBeNull();
      expect(detailsTabFor(t)).toBe("files");
    }
  });
});
