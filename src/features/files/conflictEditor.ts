/**
 * CodeMirror 6 part of the conflict resolver of the Files tab (no Solid). It reads the conflict markers of the document
 * (`conflictHunks.ts`), colours the sections of each hunk and puts a row of actions above it:
 * Accept Yours, Accept Theirs, and both in either order. An action is an ordinary edit, so Ctrl+Z undoes it and the
 * text stays editable by hand. The mode is off until `setConflictMode` turns it on (only a conflicted file uses it:
 * a `=======` line in another file is not a conflict).
 *
 * Markers show the sides of git ("ours" is the first section). During a rebase git's "ours" is the branch rebased onto,
 * which DeepGit calls Theirs, so the mode carries `swapped` and the buttons keep the names of the UI.
 *
 * Keys (when the mode is on): F7 next conflict, Shift+F7 previous.
 */
import { type ChangeSpec, type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType, keymap } from "@codemirror/view";
import { type ConflictHunk, type ParsedConflicts, type Resolution, parseLines, resolutionLines, unresolvedCount } from "./conflictHunks";

export interface ConflictMode {
  on: boolean;
  /** Rebase: the first section of a hunk is Theirs, the second is Yours. */
  swapped: boolean;
}

export const setConflictMode = StateEffect.define<ConflictMode>();

interface Field {
  mode: ConflictMode;
  parsed: ParsedConflicts;
  deco: DecorationSet;
}

const OFF: ConflictMode = { on: false, swapped: false };
const EMPTY: ParsedConflicts = { hunks: [], stray: [] };

/** The two actions that keep one side, and the two that keep both, as the UI names them: Yours, then Theirs. */
interface Action {
  label: string;
  title: (yours: string, theirs: string) => string;
  /** The resolution for a hunk whose first section is Yours (not swapped). */
  how: Resolution;
}

const ACTIONS: readonly Action[] = [
  { label: "Accept Yours", title: (y) => `Keep ${y} and drop the other side`, how: "ours" },
  { label: "Accept Theirs", title: (_, t) => `Keep ${t} and drop the other side`, how: "theirs" },
  { label: "Yours + Theirs", title: (y, t) => `Keep both: ${y} first, then ${t}`, how: "both" },
  { label: "Theirs + Yours", title: (y, t) => `Keep both: ${t} first, then ${y}`, how: "bothReversed" },
];

const SWAP: Record<Resolution, Resolution> = { ours: "theirs", theirs: "ours", both: "bothReversed", bothReversed: "both" };

/** What an action of the row does to a hunk (the resolution of the markers' ours / theirs). */
export const resolutionFor = (how: Resolution, swapped: boolean): Resolution => (swapped ? SWAP[how] : how);

class HunkBar extends WidgetType {
  constructor(
    readonly index: number,
    readonly total: number,
    readonly yours: string,
    readonly theirs: string,
    readonly swapped: boolean,
  ) {
    super();
  }

  eq(o: HunkBar): boolean {
    return o.index === this.index && o.total === this.total && o.yours === this.yours && o.theirs === this.theirs && o.swapped === this.swapped;
  }

  get estimatedHeight(): number {
    return 28;
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "dg-cf-bar";
    const label = document.createElement("span");
    label.className = "dg-cf-bar-label";
    label.textContent = `Conflict ${this.index + 1} of ${this.total}`;
    bar.append(label);
    const grow = document.createElement("span");
    grow.className = "dg-cf-bar-grow";
    bar.append(grow);
    for (const a of ACTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dg-cf-btn";
      b.textContent = a.label;
      b.title = a.title(this.yours, this.theirs);
      // keep the focus (and the cursor) in the editor
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        resolveHunkIn(view, this.index, resolutionFor(a.how, this.swapped));
      });
      bar.append(b);
    }
    return bar;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** The label of a marker line for the title of a button: the branch or commit, or the UI name when the marker has none. */
const nameOf = (label: string, fallback: string): string => (label.trim() === "" ? fallback : label.trim());

function build(mode: ConflictMode, state: EditorState): { parsed: ParsedConflicts; deco: DecorationSet } {
  if (!mode.on) return { parsed: EMPTY, deco: Decoration.none };
  const lines = [...state.doc.iterLines()];
  const parsed = parseLines(lines);
  const ranges = [];
  const first = mode.swapped ? "is-theirs" : "is-yours";
  const second = mode.swapped ? "is-yours" : "is-theirs";
  const line = (n: number, cls: string) => Decoration.line({ class: `dg-cf-line ${cls}` }).range(state.doc.line(n + 1).from);
  for (const h of parsed.hunks) {
    const yours = nameOf(mode.swapped ? h.theirsLabel : h.oursLabel, "Yours");
    const theirs = nameOf(mode.swapped ? h.oursLabel : h.theirsLabel, "Theirs");
    ranges.push(Decoration.widget({ widget: new HunkBar(h.index, parsed.hunks.length, yours, theirs, mode.swapped), block: true, side: -1 }).range(state.doc.line(h.start + 1).from));
    ranges.push(line(h.start, `is-marker ${first}`));
    const firstEnd = h.baseMarker ?? h.middle;
    for (let n = h.start + 1; n < firstEnd; n++) ranges.push(line(n, first));
    if (h.baseMarker !== null) {
      ranges.push(line(h.baseMarker, "is-marker is-base"));
      for (let n = h.baseMarker + 1; n < h.middle; n++) ranges.push(line(n, "is-base"));
    }
    ranges.push(line(h.middle, "is-marker is-middle"));
    for (let n = h.middle + 1; n < h.end; n++) ranges.push(line(n, second));
    ranges.push(line(h.end, `is-marker ${second}`));
  }
  for (const n of parsed.stray) ranges.push(line(n, "is-marker is-stray"));
  return { parsed, deco: Decoration.set(ranges, true) };
}

const conflictField = StateField.define<Field>({
  create: (state) => ({ mode: OFF, ...build(OFF, state) }),
  update(value, tr) {
    let mode = value.mode;
    for (const e of tr.effects) if (e.is(setConflictMode)) mode = e.value;
    if (mode === value.mode && !(tr.docChanged && mode.on)) return value;
    return { mode, ...build(mode, tr.state) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** The hunk to go to from the line of the cursor. Wraps around. `dir` -1 goes back. */
function hunkFrom(hunks: readonly ConflictHunk[], line: number, dir: 1 | -1): ConflictHunk | undefined {
  if (hunks.length === 0) return undefined;
  if (dir === 1) return hunks.find((h) => h.start > line) ?? hunks[0];
  return [...hunks].reverse().find((h) => h.start < line) ?? hunks[hunks.length - 1];
}

/** Moves the cursor to the start of the next or the previous conflict and scrolls it into view. Returns false without one. */
export function goToConflict(view: EditorView, dir: 1 | -1): boolean {
  const { hunks } = view.state.field(conflictField).parsed;
  const here = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  // inside a hunk, "previous" goes to the start of this one
  const h = hunkFrom(hunks, here, dir);
  if (!h) return false;
  const at = view.state.doc.line(h.start + 1).from;
  view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
  return true;
}

/** The change that resolves hunk `index` the given way, or null when there is no such hunk. */
export function hunkChange(state: EditorState, index: number, how: Resolution): ChangeSpec | null {
  const h = state.field(conflictField).parsed.hunks[index];
  if (!h) return null;
  const doc = state.doc;
  const from = doc.line(h.start + 1).from;
  const to = doc.line(h.end + 1).to;
  const lines = resolutionLines(h, how);
  if (lines.length > 0) return { from, to, insert: lines.join(state.lineBreak) };
  // nothing is kept: remove the lines with one of their line breaks
  if (h.end + 1 < doc.lines) return { from, to: doc.line(h.end + 2).from, insert: "" };
  if (h.start > 0) return { from: doc.line(h.start).to, to, insert: "" };
  return { from, to, insert: "" };
}

/** Resolves hunk `index` of the editor. It is one edit that Ctrl+Z undoes. */
export function resolveHunkIn(view: EditorView, index: number, how: Resolution): void {
  const change = hunkChange(view.state, index, how);
  if (!change) return;
  const from = (change as { from: number }).from;
  view.dispatch({ changes: change, selection: { anchor: from }, scrollIntoView: true, userEvent: "input.resolve" });
  view.focus();
}

/** True when the mode is on. */
export const conflictModeOf = (state: EditorState): ConflictMode => state.field(conflictField).mode;

/** The number of conflicts left: hunks plus stray markers. 0 when the mode is off. */
export function conflictCount(state: EditorState): number {
  return unresolvedCount(state.field(conflictField).parsed);
}

/** The number of complete hunks. */
export const hunkCount = (state: EditorState): number => state.field(conflictField).parsed.hunks.length;

/** The extension to add to the state of every file. It does nothing until `setConflictMode` turns it on. */
export function conflictExtension(): Extension {
  return [
    conflictField,
    keymap.of([
      { key: "F7", run: (v) => conflictModeOf(v.state).on && goToConflict(v, 1) },
      { key: "Shift-F7", run: (v) => conflictModeOf(v.state).on && goToConflict(v, -1) },
    ]),
  ];
}
