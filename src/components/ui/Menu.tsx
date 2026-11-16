/**
 * Context menus and dropdown menus (DESIGN.md 5.20). Mount `<MenuHost />` once (the shell does).
 *
 *   <div onContextMenu={(e) => openContextMenu(e, [
 *     { label: "Checkout", icon: "checkout", shortcut: "Enter", onSelect: () => checkout() },
 *     { separator: true },
 *     { label: "Merge into main", disabled: true, tooltip: "Already merged" },
 *     { label: "Delete", icon: "delete", danger: true, onSelect: remove },
 *     { label: "Compare", submenu: [{ label: "With HEAD", onSelect: cmp }] },
 *     { label: "Show tags", checked: showTags(), onSelect: toggle },
 *   ])} />
 *   openMenu(buttonEl, items);   // dropdown under a button
 *
 * `trailingAction` adds an icon button at the right end of a row (it replaces the shortcut text while it shows).
 * Keyboard: Up/Down/Home/End move, Right opens a submenu, Left closes it, Enter/Space selects, Esc closes.
 * Panels are keyed by depth, so hovering only moves the highlight (no remount, no re-measure, no pop-in replay). A pointer
 * travelling diagonally towards an open submenu does not close it (`menuGeometry.ts`).
 * A dropdown can carry a search field (`openMenu(button, items, { search })`): it takes the focus when the menu opens and
 * filters, as you type, the items that have `filterText` (case and accents ignored); the other items are hidden while a
 * query is on. Up/Down move over the matches, Enter selects, Esc clears the query first and closes the menu when it is empty.
 * Items are listed top to bottom exactly as given; build the array when the menu opens (`items` may be a function).
 */
import { type Accessor, For, Index, type JSX, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { trackOverlay } from "../../state/keymap";
import { closeWhenDialogOpens } from "../../state/overlays";
import { IconButton } from "./Button";
import { Icon } from "./Icon";
import { SearchField } from "./TextField";
import type { IconName } from "./icons";
import { Kbd } from "./Kbd";
import { filterMenuItems } from "./menuFilter";
import { movingToward } from "./menuGeometry";

export interface MenuItem {
  label?: string;
  icon?: IconName;
  /** Shortcut text shown at the right ("Ctrl+Shift+C"). */
  shortcut?: string;
  disabled?: boolean;
  /** Red text (destructive action). */
  danger?: boolean;
  /** Horizontal line; all other fields are ignored. */
  separator?: boolean;
  /** Small grey group title (not selectable). */
  heading?: boolean;
  /** Shows a tick; the item still needs `onSelect` to toggle. */
  checked?: boolean;
  /** Nested items; opens on hover (150 ms) or Right. */
  submenu?: MenuItem[];
  /** Tooltip (use it to say why an item is disabled). */
  tooltip?: string;
  onSelect?: () => void;
  /** F2 on the active item closes the menu and calls this (rename the thing the row stands for). */
  onRename?: () => void;
  /** Icon button at the right end of the row; shows on hover and on the active row. `Delete` on the active row runs it. */
  trailingAction?: { icon: IconName; label: string; onSelect: () => void };
  /** Text the menu's search field matches (the item's name). Items without it are hidden while a query is on. */
  filterText?: string;
}

/** Search field at the top of a dropdown. */
export interface MenuSearch {
  placeholder: string;
  /** Text shown when no item matches the query. */
  empty: string;
}

interface Level {
  items: MenuItem[];
  x: number;
  y: number;
  /** Rect of the parent item (submenus) or anchor (dropdowns). */
  parent?: DOMRect;
  active: number;
  /** Dropdowns with a search field: the field, every item, and the text typed. `items` is then the filtered view. */
  search?: MenuSearch;
  all?: MenuItem[];
  query?: string;
}

const [levels, setLevels] = createSignal<Level[]>([]);
let openTimer = 0;
/** Where the focus was when a menu with a search field opened. */
let focusBefore: HTMLElement | null = null;
/** Last pointer position seen over the menu; used to tell "moving towards the submenu" from "moving to another item". */
let lastPointer: { x: number; y: number } | null = null;

const selectable = (it: MenuItem) => !it.separator && !it.heading && !it.disabled;

function firstSelectable(items: MenuItem[], from = 0, dir: 1 | -1 = 1): number {
  const n = items.length;
  if (n === 0) return -1;
  for (let k = 0; k < n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (selectable(items[i])) return i;
  }
  return -1;
}

type PointLike = { clientX: number; clientY: number } | { x: number; y: number };

/** Opens a context menu at the pointer of `e` (calls `preventDefault` on real events). */
export function openContextMenu(e: PointLike | MouseEvent, items: MenuItem[] | (() => MenuItem[])): void {
  if ("preventDefault" in e) (e as MouseEvent).preventDefault();
  const x = "clientX" in e ? e.clientX : e.x;
  const y = "clientY" in e ? e.clientY : e.y;
  const list = typeof items === "function" ? items() : items;
  if (list.length === 0) return;
  setLevels([{ items: list, x, y, active: -1 }]);
}

/** Opens a dropdown menu under `anchor` (a button). */
export function openMenu(anchor: HTMLElement, items: MenuItem[] | (() => MenuItem[]), opts?: { search?: MenuSearch }): void {
  const r = anchor.getBoundingClientRect();
  const list = typeof items === "function" ? items() : items;
  if (list.length === 0) return;
  if (opts?.search) focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setLevels([{ items: list, x: r.left, y: r.bottom + 2, parent: r, active: -1, search: opts?.search, all: opts?.search ? list : undefined, query: "" }]);
}

/** Types into the search field of the open dropdown: shows the matches and highlights the first one. */
function setQuery(query: string): void {
  setLevels((ls) => {
    const top = ls[0];
    if (!top?.all) return ls;
    const items = filterMenuItems(top.all, query);
    return [{ ...top, query, items, active: query.trim() ? firstSelectable(items) : -1 }];
  });
}

export function closeMenu(): void {
  window.clearTimeout(openTimer);
  setLevels([]);
  // a menu with a search field took the focus: give it back
  const back = focusBefore;
  focusBefore = null;
  if (back?.isConnected) back.focus();
}

export const isMenuOpen = (): boolean => levels().length > 0;

function activate(item: MenuItem): void {
  if (!selectable(item)) return;
  if (item.submenu) return;
  closeMenu();
  item.onSelect?.();
}

function setActive(depth: number, index: number, openSub: boolean, rect?: DOMRect): void {
  setLevels((ls) => {
    const next = ls.slice(0, depth + 1);
    next[depth] = { ...next[depth], active: index };
    const item = next[depth].items[index];
    if (openSub && item?.submenu && rect && selectable(item)) {
      next.push({ items: item.submenu, x: rect.right - 4, y: rect.top - 6, parent: rect, active: firstSelectable(item.submenu) });
    }
    return next;
  });
}

function onKey(e: KeyboardEvent): void {
  const ls = levels();
  if (ls.length === 0) return;
  const depth = ls.length - 1;
  const lvl = ls[depth];
  const stop = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (e.isComposing) return; // an input method is composing text: Enter / Esc belong to it
  // in the menu's own search field these keys edit the text (Delete still runs the row's action when it has nothing to delete)
  const field = e.target instanceof HTMLInputElement && e.target.closest(".dg-menu-search") ? e.target : null;
  if (field && [" ", "Home", "End", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  if (field && e.key === "Delete" && field.selectionStart !== field.value.length) return;
  switch (e.key) {
    case "Escape":
      stop();
      if (depth === 0 && lvl.query) setQuery("");
      else if (depth > 0) setLevels(ls.slice(0, depth));
      else closeMenu();
      break;
    case "ArrowDown":
      stop();
      setActive(depth, firstSelectable(lvl.items, lvl.active < 0 ? 0 : lvl.active + 1, 1), false);
      break;
    case "ArrowUp":
      stop();
      setActive(depth, firstSelectable(lvl.items, lvl.active < 0 ? lvl.items.length - 1 : lvl.active - 1, -1), false);
      break;
    case "Home":
      stop();
      setActive(depth, firstSelectable(lvl.items, 0, 1), false);
      break;
    case "End":
      stop();
      setActive(depth, firstSelectable(lvl.items, lvl.items.length - 1, -1), false);
      break;
    case "ArrowRight": {
      stop();
      const item = lvl.items[lvl.active];
      if (item?.submenu && selectable(item)) {
        const el = document.querySelector<HTMLElement>(`[data-menu-level="${depth}"] [data-menu-index="${lvl.active}"]`);
        if (el) setActive(depth, lvl.active, true, el.getBoundingClientRect());
      }
      break;
    }
    case "ArrowLeft":
      stop();
      if (depth > 0) setLevels(ls.slice(0, depth));
      break;
    case "Enter":
    case " ": {
      stop();
      const item = lvl.items[lvl.active];
      if (!item) break;
      if (item.submenu) {
        const el = document.querySelector<HTMLElement>(`[data-menu-level="${depth}"] [data-menu-index="${lvl.active}"]`);
        if (el) setActive(depth, lvl.active, true, el.getBoundingClientRect());
      } else activate(item);
      break;
    }
    case "Tab":
      stop();
      break;
    case "Delete": {
      const item = lvl.items[lvl.active];
      if (!item?.trailingAction || !selectable(item)) break;
      stop();
      runTrailing(item);
      break;
    }
    case "F2": {
      const item = lvl.items[lvl.active];
      if (!item?.onRename || !selectable(item)) break;
      stop();
      const rename = item.onRename;
      closeMenu();
      rename();
      break;
    }
  }
}

/** Closes the menu and runs the trailing action of `item` (the button never selects the row). */
function runTrailing(item: MenuItem): void {
  const action = item.trailingAction;
  if (!action) return;
  closeMenu();
  action.onSelect();
}

/** Applies the hover result of item `index` at `depth` (highlight, and the submenu if the item has one). */
function hoverItem(depth: number, index: number, item: MenuItem, rect: DOMRect): void {
  if (item.submenu && selectable(item)) {
    setActive(depth, index, false);
    openTimer = window.setTimeout(() => setActive(depth, index, true, rect), 150);
  } else {
    setLevels((ls) => {
      const next = ls.slice(0, depth + 1);
      next[depth] = { ...next[depth], active: selectable(item) ? index : -1 };
      return next;
    });
  }
}

/**
 * One menu panel. Panels are keyed by depth (`<Index>`), so hovering only changes `level().active` and the panel stays
 * mounted: no re-measure, no `visibility: hidden` frame, no pop-in animation replay.
 */
function MenuPanel(props: { level: Accessor<Level>; depth: number }): JSX.Element {
  let box: HTMLDivElement | undefined;
  // Memos so the positioning effect does not re-run when only `active` changes.
  const x = createMemo(() => props.level().x);
  const y = createMemo(() => props.level().y);
  const parent = createMemo(() => props.level().parent);
  const items = createMemo(() => props.level().items);
  const search = createMemo(() => props.level().search);
  const noMatch = () => !!props.level().query?.trim() && items().length === 0;
  let list: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  // the highlighted row stays in view when the list scrolls
  createEffect(() => {
    const a = props.level().active;
    if (a >= 0) list?.querySelector<HTMLElement>(`[data-menu-index="${a}"]`)?.scrollIntoView({ block: "nearest" });
  });

  createEffect(() => {
    const px = x();
    const py = y();
    const pr = parent();
    items();
    if (!box) return;
    // Measure at the requested spot, using the layout size (getBoundingClientRect would include the pop-in scale).
    box.style.left = px + "px";
    box.style.top = py + "px";
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    let left = px;
    let top = py;
    if (props.depth > 0 && pr && left + w > window.innerWidth - 6) left = pr.left - w + 4;
    left = Math.min(Math.max(6, left), Math.max(6, window.innerWidth - w - 6));
    if (top + h > window.innerHeight - 6) top = Math.max(6, window.innerHeight - h - 6);
    box.style.left = left + "px";
    box.style.top = top + "px";
    box.style.visibility = "visible";
  });

  return (
    <div
      ref={box}
      class="dg-popup dg-menu"
      role="menu"
      data-menu-level={props.depth}
      style={{ visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={(e) => {
        // a click on the panel must not take the focus from the search field
        if (search() && !(e.target as Element).closest("input")) e.preventDefault();
      }}
      onMouseEnter={() => window.clearTimeout(openTimer)}
    >
      <Show when={search()}>
        {(sr) => (
          <div class="dg-menu-search">
            <SearchField
              size="filter"
              value={props.level().query ?? ""}
              onInput={setQuery}
              onClear={() => input?.focus()}
              inputRef={(el) => {
                input = el;
                queueMicrotask(() => el.focus());
              }}
              placeholder={sr().placeholder}
              aria-label={sr().placeholder}
              autocomplete="off"
              spellcheck={false}
            />
          </div>
        )}
      </Show>
      <div ref={list} class="dg-menu-list" classList={{ "is-scroll": !!search() }}>
      <Show when={noMatch()}>
        <div class="dg-menu-empty" role="status">{search()?.empty}</div>
      </Show>
      <For each={items()}>
        {(item, i) => (
          <Show
            when={!item.separator}
            fallback={<div class="dg-menu-sep" role="separator" />}
          >
            <Show
              when={!item.heading}
              fallback={<div class="dg-menu-heading">{item.label}</div>}
            >
              <div
                class="dg-menu-item"
                classList={{
                  "is-active": props.level().active === i(),
                  "is-disabled": !!item.disabled,
                  "is-danger": !!item.danger,
                  "has-trailing": !!item.trailingAction,
                }}
                role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
                aria-checked={item.checked}
                aria-disabled={item.disabled}
                aria-haspopup={item.submenu ? "menu" : undefined}
                data-menu-index={i()}
                data-tip={item.tooltip}
                onMouseEnter={(e) => {
                  window.clearTimeout(openTimer);
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ls = levels();
                  const child = ls.length > props.depth + 1 && ls[props.depth].active !== i();
                  const sub = child ? document.querySelector<HTMLElement>(`[data-menu-level="${props.depth + 1}"]`) : null;
                  // Pointer on its way to the open submenu: keep it open; leave the decision to the submenu's own mouseenter.
                  if (sub && movingToward(lastPointer, { x: e.clientX, y: e.clientY }, sub.getBoundingClientRect())) {
                    openTimer = window.setTimeout(() => hoverItem(props.depth, i(), item, rect), 250);
                    return;
                  }
                  hoverItem(props.depth, i(), item, rect);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (item.submenu) setActive(props.depth, i(), true, e.currentTarget.getBoundingClientRect());
                  else activate(item);
                }}
              >
                <span class="dg-menu-check">
                  <Show when={item.checked}>
                    <Icon name="check" size={14} />
                  </Show>
                </span>
                <span class="dg-menu-icon">
                  <Show when={item.icon}>{(n) => <Icon name={n()} />}</Show>
                </span>
                <span class="dg-menu-label">{item.label}</span>
                <Show when={item.shortcut}>
                  <span class="dg-menu-shortcut">{item.shortcut}</span>
                </Show>
                <Show when={item.trailingAction}>
                  {(a) => (
                    <IconButton
                      class="dg-menu-trailing"
                      icon={a().icon}
                      label={a().label}
                      size="small"
                      iconSize={14}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        runTrailing(item);
                      }}
                    />
                  )}
                </Show>
                <Show when={item.submenu}>
                  <Icon name="chevronRight" size={14} class="dg-menu-arrow" />
                </Show>
              </div>
            </Show>
          </Show>
        )}
      </For>
      </div>
    </div>
  );
}

/** Renders the open menu (and its submenus). Mount once near the root. */
export function MenuHost(): JSX.Element {
  trackOverlay(isMenuOpen);
  // a menu above the scrim of a dialog that opens now could be clicked: close it (one opened from the dialog stays)
  closeWhenDialogOpens(closeMenu);
  onMount(() => {
    const down = (e: PointerEvent) => {
      if (levels().length === 0) return;
      if ((e.target as Element | null)?.closest?.(".dg-menu")) return;
      closeMenu();
    };
    const dismiss = () => closeMenu();
    // a list with a search field scrolls: the wheel over it does not close the menu
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element | null)?.closest?.(".dg-menu-list.is-scroll, .dg-menu-search")) return;
      closeMenu();
    };
    const move = (e: MouseEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener("mousemove", move, true);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("wheel", wheel, { passive: true });
    onCleanup(() => {
      document.removeEventListener("mousemove", move, true);
      lastPointer = null;
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("wheel", wheel);
    });
  });
  return (
    <Show when={levels().length > 0}>
      <Portal>
        <Index each={levels()}>{(level, d) => <MenuPanel level={level} depth={d} />}</Index>
      </Portal>
    </Show>
  );
}

// Kbd is re-exported for menus that want keycaps instead of plain shortcut text.
export { Kbd as MenuKbd };
