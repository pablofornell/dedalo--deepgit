/**
 * The context menu of a row of the Files tree: `New File`, `New Folder`, `Copy path`, `Copy absolute path`, and
 * `Add to .gitignore…` (docs/design/ITERATION-3.md section 11.1). The repo root row of a multi-repo tree only has the
 * two `New` items. The empty space of the tree has the `New` items too (`newEntryMenuItems`).
 */
import { copyText, joinRepoPath, openContextMenu, type MenuItem } from "../../components/ui";
import { addToIgnore } from "../../state/actions";
import { ignoreMenuItems } from "../../state/ignoreMenu";
import { repoById } from "../../state/workspace";
import type { TreeNode } from "./model";

/** Starts a new file (`isDir` false) or folder. The caller knows where: the folder of the node that was clicked. */
export type NewEntry = (isDir: boolean) => void;

/** The `New File` and `New Folder` items, then a separator when `more` follows. */
function newEntryItems(onNew: NewEntry | undefined, more: boolean): MenuItem[] {
  if (!onNew) return [];
  return [
    { label: "New File", icon: "file", onSelect: () => onNew(false) },
    { label: "New Folder", icon: "folder", onSelect: () => onNew(true) },
    ...(more ? [{ separator: true }] : []),
  ];
}

/** The path of a folder or file node without a trailing slash. */
const cleanPath = (path: string): string => path.replace(/\/+$/, "");

/**
 * The items of the menu of `node`. `onNew` adds the `New` items. A repo row has no other item. `ignored`: git ignores the
 * entry already, so the menu does not offer to add a rule for it.
 */
export function treeMenuItems(node: TreeNode, ignored = false, onNew?: NewEntry): MenuItem[] {
  if (node.kind === "repo") return newEntryItems(onNew, false);
  if (node.kind === "draft") return [];
  const path = cleanPath(node.path);
  const root = repoById(node.repoId)?.path;
  return [
    ...newEntryItems(onNew, true),
    { label: "Copy path", icon: "copy", onSelect: () => void copyText(path) },
    {
      label: "Copy absolute path",
      icon: "path",
      disabled: !root,
      onSelect: () => {
        if (root) void copyText(joinRepoPath(root, path));
      },
    },
    ...(ignored ? [] : ignoreMenuItems([{ repoId: node.repoId, path, isDir: node.kind === "dir" }], addToIgnore)),
  ];
}

/** Opens the menu of `node` at the pointer. */
export function openTreeMenu(node: TreeNode, e: MouseEvent, ignored = false, onNew?: NewEntry): void {
  openContextMenu(e, treeMenuItems(node, ignored, onNew));
}

/** The items of the dropdown of the `+` button in the tree header, and of a right-click on the empty space of the tree. */
export function newEntryMenuItems(onNew: NewEntry): MenuItem[] {
  return newEntryItems(onNew, false);
}
