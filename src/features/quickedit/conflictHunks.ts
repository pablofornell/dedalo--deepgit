/**
 * Conflict markers of a text file as hunks, and the edits that resolve one hunk. Pure, no DOM, no CodeMirror.
 *
 *   const { hunks } = parseConflicts("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> topic\nd\n");
 *   hunks[0].ours      // ["b"]
 *   hunks[0].theirs    // ["c"]
 *   resolveHunk(text, 0, "both")   // "a\nb\nc\nd\n"
 *
 * The text is split at "\n" only (a text that ends with a newline has a last empty line, the same as a CodeMirror
 * document). A "\r" before the "\n" stays in the line, so CRLF files and a missing final newline come back as they
 * were. A marker line is recognised after the "\r" is ignored.
 *
 * Git writes `<<<<<<< label`, optionally `||||||| label` (the diff3 style, the common ancestor), `=======` and
 * `>>>>>>> label`. The four markers of one hunk have the same length (7 characters; the `conflict-marker-size`
 * attribute can make it longer). "ours" is the first section, the one after `<<<<<<<` (git's "ours": during a rebase
 * that is the branch the rebase goes onto, not the commit being replayed). The caller maps it to the names of the UI.
 *
 * An opening marker that never closes, and a closing marker without an opening one, are reported as `stray`: the file
 * still has markers, although there is no hunk to resolve. A lone `=======` (a Markdown heading) is not a marker.
 */

/** One complete `<<<<<<<` ... `>>>>>>>` block. Line numbers are 0-based indexes into the lines of the text. */
export interface ConflictHunk {
  /** Position in the list of hunks of the text. */
  index: number;
  /** The `<<<<<<<` line. */
  start: number;
  /** The `|||||||` line of a diff3 hunk, or null. */
  baseMarker: number | null;
  /** The `=======` line. */
  middle: number;
  /** The `>>>>>>>` line. */
  end: number;
  /** Length of the markers of this hunk. */
  markerLen: number;
  oursLabel: string;
  /** Label of the common ancestor, `null` when the hunk has no base section. */
  baseLabel: string | null;
  theirsLabel: string;
  ours: string[];
  /** The common ancestor lines of a diff3 hunk, or null. */
  base: string[] | null;
  theirs: string[];
}

export interface ParsedConflicts {
  hunks: ConflictHunk[];
  /** 0-based lines of markers that belong to no complete hunk (an opening marker never closed, a closing one alone). */
  stray: number[];
}

/** What a hunk can be replaced with. `both` = ours then theirs; `bothReversed` = theirs then ours. */
export type Resolution = "ours" | "theirs" | "both" | "bothReversed";

export const MIN_MARKER = 7;

const OPEN = /^(<{7,})(?: (.*))?$/;
const END = /^(>{7,})(?: (.*))?$/;

/** Splits at "\n". Joining the result with "\n" gives the text back. */
export const splitLines = (text: string): string[] => text.split("\n");

const bare = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

/** The hunks and the stray markers of `lines` (see `splitLines`). */
export function parseLines(lines: readonly string[]): ParsedConflicts {
  const hunks: ConflictHunk[] = [];
  const stray: number[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const open = OPEN.exec(bare(lines[i]));
    if (!open) {
      if (END.test(bare(lines[i]))) stray.push(i);
      i++;
      continue;
    }
    const len = open[1].length;
    const middleText = "=".repeat(len);
    const baseRe = new RegExp(`^\\|{${len}}(?: (.*))?$`);
    const endRe = new RegExp(`^>{${len}}(?: (.*))?$`);
    let baseAt = -1;
    let baseLabel: string | null = null;
    let middle = -1;
    let end = -1;
    let endLabel = "";
    let j = i + 1;
    for (; j < n; j++) {
      const t = bare(lines[j]);
      if (OPEN.test(t)) break; // a new hunk starts here: this one never closed
      if (middle < 0) {
        const b = baseAt < 0 ? baseRe.exec(t) : null;
        if (b) {
          baseAt = j;
          baseLabel = b[1] ?? "";
        } else if (t === middleText) middle = j;
      } else {
        const e = endRe.exec(t);
        if (e) {
          end = j;
          endLabel = e[1] ?? "";
          break;
        }
      }
    }
    if (end < 0) {
      stray.push(i);
      // Stopped at a new opening marker: go on from it. Stopped at the end of the text: nothing else can open here.
      i = j < n ? j : i + 1;
      continue;
    }
    hunks.push({
      index: hunks.length,
      start: i,
      baseMarker: baseAt >= 0 ? baseAt : null,
      middle,
      end,
      markerLen: len,
      oursLabel: open[2] ?? "",
      baseLabel: baseAt >= 0 ? baseLabel : null,
      theirsLabel: endLabel,
      ours: lines.slice(i + 1, baseAt >= 0 ? baseAt : middle),
      base: baseAt >= 0 ? lines.slice(baseAt + 1, middle) : null,
      theirs: lines.slice(middle + 1, end),
    });
    i = end + 1;
  }
  return { hunks, stray };
}

export const parseConflicts = (text: string): ParsedConflicts => parseLines(splitLines(text));

/** True when the text has a hunk or a stray marker: a file that is not resolved yet. */
export function hasConflictMarkers(text: string): boolean {
  const p = parseConflicts(text);
  return p.hunks.length > 0 || p.stray.length > 0;
}

/** Hunks left plus stray markers: what stands between the file and "resolved". */
export const unresolvedCount = (p: ParsedConflicts): number => p.hunks.length + p.stray.length;

/** The lines that take the place of `hunk` for the resolution. */
export function resolutionLines(hunk: ConflictHunk, how: Resolution): string[] {
  switch (how) {
    case "ours":
      return hunk.ours;
    case "theirs":
      return hunk.theirs;
    case "both":
      return [...hunk.ours, ...hunk.theirs];
    case "bothReversed":
      return [...hunk.theirs, ...hunk.ours];
  }
}

/** `lines` with the hunk replaced by the resolution. */
export function applyResolution(lines: readonly string[], hunk: ConflictHunk, how: Resolution): string[] {
  return [...lines.slice(0, hunk.start), ...resolutionLines(hunk, how), ...lines.slice(hunk.end + 1)];
}

/** `text` with hunk number `index` resolved. An unknown index gives the text back. */
export function resolveHunk(text: string, index: number, how: Resolution): string {
  const lines = splitLines(text);
  const hunk = parseLines(lines).hunks[index];
  return hunk ? applyResolution(lines, hunk, how).join("\n") : text;
}

/** `text` with every hunk resolved the same way. Stray markers stay. */
export function resolveAll(text: string, how: Resolution): string {
  const lines = splitLines(text);
  const { hunks } = parseLines(lines);
  const out: string[] = [];
  let at = 0;
  for (const h of hunks) {
    out.push(...lines.slice(at, h.start), ...resolutionLines(h, how));
    at = h.end + 1;
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}
