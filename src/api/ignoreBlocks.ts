/**
 * Blocks of ignore rules (the gitignore templates, `state/gitignoreTemplates.ts`). Pure rules that the browser mock and the
 * templates dialog share. They are those of `files::append_ignore_blocks` in crates/gitcore/src/files.rs.
 */
import type { IgnoreBlock } from "./types";

/** A comment line, or an empty one: it is not a pattern. */
export const isPatternLine = (line: string): boolean => {
  const t = line.trim();
  return t !== "" && !t.startsWith("#");
};

/**
 * The lines of a block that stay. A pattern that `known` holds is left out, and so is a comment when no pattern is left
 * under it. Groups keep one empty line between them. The patterns that stay are added to `known` (a later block does not
 * repeat them). Empty when no pattern is new.
 */
export function tidyBlock(lines: readonly string[], known: Set<string>): string[] {
  const out: string[] = [];
  let comments: string[] = [];
  let blank = false;
  for (const l of lines) {
    if (l.trim() === "") {
      comments = [];
      blank = out.length > 0;
    } else if (l.trim().startsWith("#")) {
      comments.push(l);
    } else if (!known.has(l)) {
      known.add(l);
      if (blank) out.push("");
      blank = false;
      out.push(...comments, l);
      comments = [];
    }
  }
  return out;
}

const BOM = "\ufeff";

/** The lines of an ignore text, to compare. A byte order mark before the first line is not part of it (git skips it too). */
export function textLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.startsWith(BOM)) lines[0] = lines[0].slice(1);
  return lines;
}

/** True when a line of `text` is `header`: the template was added to this file already. */
export function hasHeader(text: string, header: string): boolean {
  const h = header.trimEnd();
  return textLines(text).some((l) => l.trimEnd() === h);
}

/**
 * The line end for new lines: `\r\n` when the text has at least as many `\r\n` as bare `\n` line ends (and one at least), else `\n`.
 * A text that mixes both keeps its lines as they are (`files::dominant_eol`).
 */
export function dominantEol(text: string): "\r\n" | "\n" {
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return crlf > 0 && crlf >= lf - crlf ? "\r\n" : "\n";
}

/** True when a new block needs an empty line before it: the text is not empty and its last line is not blank. */
export function needsGap(existing: string): boolean {
  const old = textLines(existing);
  if (old[old.length - 1] === "") old.pop();
  return old.length > 0 && old[old.length - 1].trim() !== "";
}

/** Why `append_ignore_blocks` refuses a block, or null. */
export function blockError(b: IgnoreBlock): string | null {
  if (!b.header.startsWith("#")) return "The header of a block must be a comment.";
  if ([b.header, ...b.lines].some((l) => /[\0\n\r]/.test(l))) return "A pattern cannot contain a line break or a NUL character.";
  return null;
}

/** A block that `placeBlocks` adds: its lines (without the header), and where it goes. */
export interface PlacedBlock {
  header: string;
  /** What stays of the block (`tidyBlock`). */
  lines: string[];
  /** The header of the block of the file that this one goes before. Null: at the end of the file. */
  before: string | null;
}

const sameLine = (a: string, b: string): boolean => a.trimEnd() === b.trimEnd();

/**
 * Where `blocks` go in an ignore file, and the text that results (`files::append_ignore_blocks`). `order` lists the headers of
 * every template in their canonical order. A new block goes before the first block of the file that comes later in `order`
 * (the file keeps the order of the templates, so a `*.jar` that comes later cannot hide the `!gradle-wrapper.jar` of a block
 * above), else at the end after an empty line. Blocks are placed in the order of `order`. A block whose header the text holds,
 * and a block with no new pattern, are skipped. Each block is its header and the lines that `tidyBlock` keeps, and an empty line
 * separates blocks. A text that does not end with a line break gets one before new lines at its end. The lines that the text
 * has stay as they are, also a line end that differs from the rest; the new lines use the dominant line end. `canInsert` false
 * (a file that is not UTF-8) puts every block at the end. A byte order mark stays at the start.
 */
export function placeBlocks(
  existing: string,
  blocks: readonly IgnoreBlock[],
  order: readonly string[] = [],
  canInsert = true,
): { text: string; placed: PlacedBlock[] } {
  const old = textLines(existing);
  if (old[old.length - 1] === "") old.pop();
  const known = new Set(old);
  const rank = (h: string): number => {
    const i = order.findIndex((o) => sameLine(o, h));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  // The template blocks of the text: line of the header and place in `order`.
  const have = old.flatMap((l, i) => (rank(l) < Number.MAX_SAFE_INTEGER ? [{ line: i, rank: rank(l), header: l.trimEnd() }] : []));
  const sorted = [...blocks].sort((a, b) => rank(a.header) - rank(b.header));
  const placed: PlacedBlock[] = [];
  const inside = new Map<number, PlacedBlock[]>();
  const end: PlacedBlock[] = [];
  for (const b of sorted) {
    if (old.some((l) => sameLine(l, b.header))) continue;
    const lines = tidyBlock(b.lines, known);
    if (lines.length === 0) continue;
    const r = rank(b.header);
    const spot = r === Number.MAX_SAFE_INTEGER || !canInsert ? undefined : have.find((h) => h.rank > r);
    const block: PlacedBlock = { header: b.header.trimEnd(), lines, before: spot?.header ?? null };
    placed.push(block);
    if (spot) inside.set(spot.line, [...(inside.get(spot.line) ?? []), block]);
    else end.push(block);
  }
  if (placed.length === 0) return { text: existing, placed };
  const eol = dominantEol(existing);
  const gap = old.length > 0 && old[old.length - 1].trim() !== "";
  const tail: string[] = [];
  end.forEach((b, i) => {
    if (i > 0 || gap) tail.push("");
    tail.push(b.header, ...b.lines);
  });
  if (inside.size === 0) {
    const lead = existing !== "" && !existing.endsWith("\n") ? eol : "";
    return { text: existing + lead + tail.map((l) => l + eol).join(""), placed };
  }
  const bom = existing.startsWith(BOM) ? BOM : "";
  const body = existing.slice(bom.length);
  let out = bom;
  const parts = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  parts.forEach((raw, i) => {
    const group = inside.get(i);
    if (group) {
      if (i > 0 && old[i - 1].trim() !== "") out += eol;
      for (const b of group) out += [b.header, ...b.lines, ""].map((l) => l + eol).join("");
    }
    out += raw;
  });
  if (tail.length > 0 && parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) out += eol;
  out += tail.map((l) => l + eol).join("");
  return { text: out, placed };
}

/** `placeBlocks` for the callers that need the text and the headers added only. */
export function appendIgnoreBlocks(existing: string, blocks: readonly IgnoreBlock[], order: readonly string[] = [], canInsert = true): { text: string; added: string[] } {
  const { text, placed } = placeBlocks(existing, blocks, order, canInsert);
  return { text, added: placed.map((p) => p.header) };
}
