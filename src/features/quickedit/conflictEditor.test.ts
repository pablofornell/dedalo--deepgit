import { EditorState, type Extension } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { crlfInput } from "./lineEnds";
import { conflictCount, conflictExtension, conflictModeOf, hunkChange, hunkCount, resolutionFor, setConflictMode } from "./conflictEditor";

const TEXT = "a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> topic\nd\n<<<<<<< HEAD\nx\n=======\n>>>>>>> topic\n";

function state(doc: string, on = true, swapped = false, crlf = false): EditorState {
  const extensions: Extension[] = [conflictExtension()];
  if (crlf) extensions.push(EditorState.lineSeparator.of("\r\n"), crlfInput);
  const st = EditorState.create({ doc, extensions });
  return on ? st.update({ effects: setConflictMode.of({ on, swapped }) }).state : st;
}

/** The text after the hunk was resolved with `how` (what the button of the row does). */
function after(st: EditorState, index: number, how: Parameters<typeof hunkChange>[2]): string {
  const change = hunkChange(st, index, how);
  if (!change) throw new Error("no hunk");
  return st.update({ changes: change }).state.sliceDoc();
}

describe("conflict mode", () => {
  it("is off until it is turned on, so a lone marker line is not a conflict", () => {
    const st = state(TEXT, false);
    expect(conflictModeOf(st).on).toBe(false);
    expect(conflictCount(st)).toBe(0);
    expect(hunkChange(st, 0, "ours")).toBeNull();
  });

  it("counts the hunks once it is on, and again after each edit", () => {
    const st = state(TEXT);
    expect(hunkCount(st)).toBe(2);
    expect(conflictCount(st)).toBe(2);
    const next = st.update({ changes: hunkChange(st, 0, "ours")! }).state;
    expect(conflictCount(next)).toBe(1);
  });

  it("counts stray markers as conflicts left", () => {
    const st = state("a\n<<<<<<< HEAD\nb\n");
    expect(hunkCount(st)).toBe(0);
    expect(conflictCount(st)).toBe(1);
  });

  it("goes back to zero when it is turned off", () => {
    const st = state(TEXT);
    const off = st.update({ effects: setConflictMode.of({ on: false, swapped: false }) }).state;
    expect(conflictCount(off)).toBe(0);
  });
});

describe("hunkChange", () => {
  it("resolves one hunk in each way", () => {
    const st = state(TEXT);
    const rest = "<<<<<<< HEAD\nx\n=======\n>>>>>>> topic\n";
    expect(after(st, 0, "ours")).toBe("a\nb\nd\n" + rest);
    expect(after(st, 0, "theirs")).toBe("a\nc\nd\n" + rest);
    expect(after(st, 0, "both")).toBe("a\nb\nc\nd\n" + rest);
    expect(after(st, 0, "bothReversed")).toBe("a\nc\nb\nd\n" + rest);
  });

  it("removes the lines of an empty side, also at the end of the text and at the start", () => {
    const st = state(TEXT);
    expect(after(st, 1, "theirs")).toBe("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> topic\nd\n");
    const noEol = state("a\n<<<<<<< HEAD\nx\n=======\n>>>>>>> topic");
    expect(after(noEol, 0, "theirs")).toBe("a");
    const first = state("<<<<<<< HEAD\nx\n=======\n>>>>>>> topic");
    expect(after(first, 0, "theirs")).toBe("");
  });

  it("writes the lines of a CRLF document with CRLF", () => {
    const st = state("a\r\n<<<<<<< HEAD\r\nb\r\n=======\r\nc\r\n>>>>>>> topic\r\nd\r\n", true, false, true);
    expect(hunkCount(st)).toBe(1);
    expect(after(st, 0, "both")).toBe("a\r\nb\r\nc\r\nd\r\n");
    expect(after(st, 0, "theirs")).toBe("a\r\nc\r\nd\r\n");
  });

  it("keeps a missing final newline", () => {
    const st = state("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> topic");
    expect(after(st, 0, "ours")).toBe("a\nb");
  });

  it("drops the base section of a diff3 hunk", () => {
    const st = state("<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> topic\n");
    expect(after(st, 0, "both")).toBe("ours\ntheirs\n");
  });
});

describe("resolutionFor", () => {
  it("swaps the sides during a rebase", () => {
    expect(resolutionFor("ours", false)).toBe("ours");
    expect(resolutionFor("ours", true)).toBe("theirs");
    expect(resolutionFor("both", true)).toBe("bothReversed");
    expect(resolutionFor("bothReversed", true)).toBe("both");
  });
});
