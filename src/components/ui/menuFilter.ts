/** Search of a dropdown menu (`Menu.tsx`): which items a typed query leaves. Pure, tested under node. */
import type { MenuItem } from "./Menu";

/** Lower case, accents removed: "cafe" matches "Café". */
const foldText = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** The items a query leaves: those whose `filterText` holds it. An empty query leaves all of them. */
export function filterMenuItems(all: readonly MenuItem[], query: string): MenuItem[] {
  const q = foldText(query.trim());
  if (!q) return [...all];
  return all.filter((it) => it.filterText !== undefined && foldText(it.filterText).includes(q));
}
