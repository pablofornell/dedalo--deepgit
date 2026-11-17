import { describe, expect, it } from "vitest";
import { hasConflictMarkers, parseConflicts, resolveAll, resolveHunk, resolutionLines, unresolvedCount } from "./conflictHunks";

const two = ["a", "<<<<<<< HEAD", "b1", "=======", "c1", ">>>>>>> topic", "d", "<<<<<<< HEAD", "b2", "b3", "=======", "c2", ">>>>>>> topic", "e", ""].join("\n");

describe("parseConflicts", () => {
  it("finds no hunk in a plain text", () => {
    const p = parseConflicts("a\nb\n");
    expect(p.hunks).toEqual([]);
    expect(p.stray).toEqual([]);
    expect(hasConflictMarkers("a\nb\n")).toBe(false);
  });

  it("reads one hunk: sides, labels and marker lines", () => {
    const p = parseConflicts("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> feature/x\nd\n");
    expect(p.hunks).toHaveLength(1);
    const h = p.hunks[0];
    expect(h).toMatchObject({ index: 0, start: 1, middle: 3, end: 5, baseMarker: null, base: null, baseLabel: null, markerLen: 7 });
    expect(h.ours).toEqual(["b"]);
    expect(h.theirs).toEqual(["c"]);
    expect(h.oursLabel).toBe("HEAD");
    expect(h.theirsLabel).toBe("feature/x");
  });

  it("reads several hunks in order", () => {
    const p = parseConflicts(two);
    expect(p.hunks.map((h) => [h.index, h.start, h.end])).toEqual([[0, 1, 5], [1, 7, 12]]);
    expect(p.hunks[1].ours).toEqual(["b2", "b3"]);
    expect(unresolvedCount(p)).toBe(2);
  });

  it("reads the base section of a diff3 hunk", () => {
    const p = parseConflicts("<<<<<<< HEAD\nours\n||||||| merged common ancestors\nold\nolder\n=======\ntheirs\n>>>>>>> topic");
    const h = p.hunks[0];
    expect(h.baseMarker).toBe(2);
    expect(h.baseLabel).toBe("merged common ancestors");
    expect(h.base).toEqual(["old", "older"]);
    expect(h.ours).toEqual(["ours"]);
    expect(h.theirs).toEqual(["theirs"]);
  });

  it("accepts empty sections and markers without a label", () => {
    const p = parseConflicts("<<<<<<<\n=======\nx\n>>>>>>>\n");
    expect(p.hunks[0].ours).toEqual([]);
    expect(p.hunks[0].theirs).toEqual(["x"]);
    expect(p.hunks[0].oursLabel).toBe("");
    expect(p.hunks[0].theirsLabel).toBe("");
  });

  it("ignores the CR of CRLF lines when it looks for markers and keeps it in the content", () => {
    const text = "a\r\n<<<<<<< HEAD\r\nb\r\n=======\r\nc\r\n>>>>>>> topic\r\nd\r\n";
    const h = parseConflicts(text).hunks[0];
    expect(h.ours).toEqual(["b\r"]);
    expect(h.theirs).toEqual(["c\r"]);
    expect(h.oursLabel).toBe("HEAD");
    expect(h.theirsLabel).toBe("topic");
  });

  it("finds a hunk whose closing marker is the last line, without a final newline", () => {
    const p = parseConflicts("<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> topic");
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0].end).toBe(4);
  });

  it("uses the marker length of the hunk, and does not mix lengths", () => {
    const text = "<<<<<<<<<< HEAD\nb\n==========\nc\n>>>>>>>>>> topic\n";
    const h = parseConflicts(text).hunks[0];
    expect(h.markerLen).toBe(10);
    expect(h.ours).toEqual(["b"]);
    // a `=======` (7) is content in a hunk of 10
    const inner = parseConflicts("<<<<<<<<<< HEAD\nb\n=======\n==========\nc\n>>>>>>>>>> topic\n").hunks[0];
    expect(inner.ours).toEqual(["b", "======="]);
    expect(inner.theirs).toEqual(["c"]);
  });

  it("does not take a lone ======= (Markdown heading) for a conflict", () => {
    const p = parseConflicts("Title\n=======\ntext\n");
    expect(p.hunks).toEqual([]);
    expect(p.stray).toEqual([]);
  });

  it("reports an opening marker that never closes as stray", () => {
    const p = parseConflicts("a\n<<<<<<< HEAD\nb\n=======\nc\n");
    expect(p.hunks).toEqual([]);
    expect(p.stray).toEqual([1]);
    expect(hasConflictMarkers("a\n<<<<<<< HEAD\nb\n")).toBe(true);
  });

  it("reports a closing marker without an opening one as stray", () => {
    const p = parseConflicts("a\n>>>>>>> topic\n");
    expect(p.stray).toEqual([1]);
    expect(unresolvedCount(p)).toBe(1);
  });

  it("restarts at a new opening marker and keeps the complete hunk after a broken one", () => {
    const p = parseConflicts("<<<<<<< one\nx\n<<<<<<< two\ny\n=======\nz\n>>>>>>> t\n");
    expect(p.stray).toEqual([0]);
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0].start).toBe(2);
    expect(p.hunks[0].oursLabel).toBe("two");
  });

  it("needs the middle marker before the closing one", () => {
    const p = parseConflicts("<<<<<<< HEAD\nb\n>>>>>>> topic\n");
    expect(p.hunks).toEqual([]);
    expect(p.stray).toEqual([0, 2]);
  });
});

describe("resolveHunk", () => {
  it("takes ours", () => {
    expect(resolveHunk(two, 0, "ours")).toBe(["a", "b1", "d", "<<<<<<< HEAD", "b2", "b3", "=======", "c2", ">>>>>>> topic", "e", ""].join("\n"));
  });

  it("takes theirs", () => {
    expect(resolveHunk(two, 1, "theirs")).toBe(["a", "<<<<<<< HEAD", "b1", "=======", "c1", ">>>>>>> topic", "d", "c2", "e", ""].join("\n"));
  });

  it("takes both, in either order", () => {
    expect(resolveHunk(two, 1, "both")).toContain("d\nb2\nb3\nc2\ne\n");
    expect(resolveHunk(two, 1, "bothReversed")).toContain("d\nc2\nb2\nb3\ne\n");
  });

  it("leaves the text alone for an index that does not exist", () => {
    expect(resolveHunk(two, 5, "ours")).toBe(two);
  });

  it("removes the lines of an empty side", () => {
    expect(resolveHunk("a\n<<<<<<< HEAD\n=======\nx\n>>>>>>> t\nb\n", 0, "ours")).toBe("a\nb\n");
  });

  it("drops the base section of a diff3 hunk", () => {
    const text = "<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> topic\n";
    expect(resolveHunk(text, 0, "ours")).toBe("ours\n");
    expect(resolveHunk(text, 0, "theirs")).toBe("theirs\n");
    expect(resolveHunk(text, 0, "both")).toBe("ours\ntheirs\n");
  });

  it("keeps CRLF line ends", () => {
    const text = "a\r\n<<<<<<< HEAD\r\nb\r\n=======\r\nc\r\n>>>>>>> topic\r\nd\r\n";
    expect(resolveHunk(text, 0, "both")).toBe("a\r\nb\r\nc\r\nd\r\n");
    expect(resolveHunk(text, 0, "theirs")).toBe("a\r\nc\r\nd\r\n");
  });

  it("keeps a missing final newline", () => {
    const text = "a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> topic";
    expect(resolveHunk(text, 0, "theirs")).toBe("a\nc");
    expect(resolveHunk("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> topic\n", 0, "theirs")).toBe("a\nc\n");
  });

  it("renumbers the hunks after one is resolved", () => {
    const once = resolveHunk(two, 0, "ours");
    expect(parseConflicts(once).hunks).toHaveLength(1);
    expect(resolveHunk(once, 0, "theirs")).toBe("a\nb1\nd\nc2\ne\n");
  });
});

describe("resolveAll", () => {
  it("resolves every hunk the same way", () => {
    expect(resolveAll(two, "ours")).toBe("a\nb1\nd\nb2\nb3\ne\n");
    expect(resolveAll(two, "theirs")).toBe("a\nc1\nd\nc2\ne\n");
    expect(resolveAll(two, "both")).toBe("a\nb1\nc1\nd\nb2\nb3\nc2\ne\n");
    expect(resolveAll(two, "bothReversed")).toBe("a\nc1\nb1\nd\nc2\nb2\nb3\ne\n");
    expect(hasConflictMarkers(resolveAll(two, "ours"))).toBe(false);
  });

  it("leaves stray markers", () => {
    const text = "<<<<<<< lost\nx\n" + "<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> t\n";
    const out = resolveAll(text, "ours");
    expect(out).toBe("<<<<<<< lost\nx\nb\n");
    expect(parseConflicts(out).stray).toEqual([0]);
  });

  it("gives a text without hunks back unchanged", () => {
    expect(resolveAll("a\nb", "ours")).toBe("a\nb");
  });
});

describe("resolutionLines", () => {
  it("lists the lines for each resolution", () => {
    const h = parseConflicts("<<<<<<< a\n1\n=======\n2\n>>>>>>> b\n").hunks[0];
    expect(resolutionLines(h, "ours")).toEqual(["1"]);
    expect(resolutionLines(h, "theirs")).toEqual(["2"]);
    expect(resolutionLines(h, "both")).toEqual(["1", "2"]);
    expect(resolutionLines(h, "bothReversed")).toEqual(["2", "1"]);
  });
});
