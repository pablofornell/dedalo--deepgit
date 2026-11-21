// @vitest-environment node
import { describe, expect, it } from "vitest";
import { anyRepoVersion, notifyRepoChanged, notifyWorkingTreeChanged, repoVersion, workingTreeVersion } from "./events";

describe("working tree version", () => {
  it("moves only the readers of the working tree, not the repo or the any-repo counters", () => {
    const repo = repoVersion("wt-a");
    const any = anyRepoVersion();
    const wt = workingTreeVersion("wt-a");
    notifyWorkingTreeChanged("wt-a");
    expect(workingTreeVersion("wt-a")).toBe(wt + 1);
    expect(repoVersion("wt-a")).toBe(repo);
    expect(anyRepoVersion()).toBe(any);
  });

  it("is per repo, and a repo change does not move it", () => {
    const other = workingTreeVersion("wt-b");
    notifyWorkingTreeChanged("wt-a");
    expect(workingTreeVersion("wt-b")).toBe(other);
    const wt = workingTreeVersion("wt-a");
    notifyRepoChanged("wt-a");
    expect(workingTreeVersion("wt-a")).toBe(wt);
  });
});
