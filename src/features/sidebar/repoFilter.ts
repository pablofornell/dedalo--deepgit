/** Accent- and case-insensitive text matching used to highlight the speed search in the sidebar tree ("cafe" finds "Café"). */

/** Lower case, accents removed (`é` -> `e`). */
const foldChar = (ch: string) => ch.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Folded text with, for each folded character, where its source character starts and ends in the original. */
function fold(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  for (const ch of text) {
    const piece = foldChar(ch);
    for (let i = 0; i < piece.length; i++) {
      starts.push(at);
      ends.push(at + ch.length);
    }
    folded += piece;
    at += ch.length;
  }
  return { folded, starts, ends };
}

/** The text the user typed, ready to match: trimmed, folded. "" = no filter. */
export const normalizeQuery = (query: string): string => fold(query.trim()).folded;

/** Range of the first match of `query` in `text` (indexes in `text`, end exclusive), or null. Case and accents are ignored. */
export function findMatch(text: string, query: string): { start: number; end: number } | null {
  const q = normalizeQuery(query);
  if (!q) return null;
  const { folded, starts, ends } = fold(text);
  const i = folded.indexOf(q);
  if (i < 0) return null;
  // a combining accent folds to nothing: keep it inside the range, so a highlight does not split "é" in two
  let end = ends[i + q.length - 1];
  while (end < text.length && /[\u0300-\u036f]/.test(text[end])) end++;
  return { start: starts[i], end };
}
