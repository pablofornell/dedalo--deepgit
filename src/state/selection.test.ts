// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { clearSelection, detailsTab, selectFile, setDetailsTab, setSelectedCommit } from "./selection";

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
