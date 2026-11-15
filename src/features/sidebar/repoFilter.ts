/**
 * Pure rules of the project filter field of the sidebar (`Sidebar.tsx`, `state/projectFilter.ts`), tested under node.
 *
 * The filter matches the name of a repository (its folder name, and the last part of its path) and the name of a
 * folder group. Case and accents do not count: "cafe" finds "Café". A folder whose own name matches keeps everything
 * below it; a folder or a repo whose name does not match stays only while something below it matches.
 */
import type { SidebarNode } from "./nodes";

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

/** Last part of a path ("/w/api/" -> "api"). */
const lastSegment = (path: string): string => path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;

/** A repo matches by the label of its row (the folder name) or the last part of its path. */
export function repoMatches(label: string, path: string | undefined, query: string): boolean {
  return findMatch(label, query) !== null || (path !== undefined && findMatch(lastSegment(path), query) !== null);
}

const isLevel = (n: SidebarNode) => n.kind === "folder" || n.kind === "repo";

/**
 * Keeps the folders and repos that match `query`, in the same tree. `pathOf` gives the path of a repo. An empty query
 * returns the nodes as they are. A matching folder or repo keeps its own children (repos, branches, nested repos).
 */
export function filterRepoTree(nodes: readonly SidebarNode[], query: string, pathOf: (repoId: string) => string | undefined): SidebarNode[] {
  if (!normalizeQuery(query)) return [...nodes];
  const walk = (list: readonly SidebarNode[]): SidebarNode[] => {
    const out: SidebarNode[] = [];
    for (const n of list) {
      if (n.kind === "folder") {
        if (findMatch(n.label, query)) out.push(n);
        else {
          const kids = walk(n.children);
          if (kids.length > 0) out.push({ ...n, children: kids });
        }
      } else if (n.kind === "repo") {
        if (repoMatches(n.label, pathOf(n.repoId), query)) out.push(n);
        else {
          const kids = walk(n.children.filter(isLevel));
          if (kids.length > 0) out.push({ ...n, children: kids });
        }
      }
    }
    return out;
  };
  return walk(nodes);
}
