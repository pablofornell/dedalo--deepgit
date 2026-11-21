/**
 * "Local changes" tab (DESIGN.md 5.12, 5.13): every selected repo that has changes, grouped by repo, with
 * Conflicts / Staged / Unstaged sections, tree or flat file rows, multi-selection, keyboard, a commit box and
 * the banner of a merge / rebase / cherry-pick in progress. The diff of the selected file is the "File changes" tab's job.
 */
import { For, type JSX, Show, createEffect, createMemo, createResource, createSignal, mapArray, on, onCleanup, onMount } from "solid-js";
import * as api from "../../api/tauri";
import type { RepoStateKind, WorkingTree } from "../../api/types";
import {
  Button, HeaderSlot, Icon, SegmentedControl, Splitter, copyText, joinRepoPath, loadSplitSize, openContextMenu, plural,
  type MenuItem, type VirtualListApi,
} from "../../components/ui";
import * as actions from "../../state/actions";
import { formatDate, fullDate } from "../../state/dates";
import { confirmAction } from "../../state/dialogs";
import { repoVersion, workingTreeVersion } from "../../state/events";
import { ignoreMenuItems, type IgnoreRef } from "../../state/ignoreMenu";
import { register } from "../../state/keymap";
import { loadPersisted, savePersisted } from "../../state/persist";
import { changesRepoId, changesScopeRepos, fileFor, mainTab, selectFile, setChangesRepoId } from "../../state/selection";
import { isRepoFilterActive, projectRepos, repoById, summary } from "../../state/workspace";
import { CommitBox, DEFAULT_HEIGHT, type CommitTarget } from "./CommitBox";
import {
  PANES, PANE_TITLE, buildRows, isSelectableKey, nearestSurvivor, paneOfKey, rangeKeys, repoIdOfKey, rowItems, sectionFiles, selectedItems, stashFilesOf,
  type FileItem, type Pane, type Row, type Section, type ViewMode,
} from "./model";
import { cssPx, isCompact, stagedHeight } from "./layout";
import { combineSelection, type MarqueeMode } from "./marquee";
import { createRetrier } from "./loadRetry";
import { discardItems, discardable, stageItems, toggleStage, unstageItems } from "./ops";
import { PaneList, type MarqueeHandlers } from "./PaneList";
import { Action, DirRowView, FileRowView, RepoRowView, SectionRowView, type DirRow, type FileRow, type RepoRow, type RowCtl, type SectionRow } from "./Rows";
import "./changes.css";

const rowH = (): number => cssPx("--dg-file-row-height", 24);

const OP_LABEL: Partial<Record<RepoStateKind, string>> = { merging: "Merge", rebasing: "Rebase", cherryPicking: "Cherry-pick", reverting: "Revert" };

const totalFiles = (wt: WorkingTree | undefined): number => (wt ? wt.staged.length + wt.unstaged.length + wt.conflicted.length : 0);

export function ChangesView(): JSX.Element {
  const [mode, setModeRaw] = createSignal<ViewMode>(loadPersisted<ViewMode>("changes.mode", "tree") === "flat" ? "flat" : "tree");
  const setMode = (m: ViewMode) => {
    setModeRaw(m);
    savePersisted("changes.mode", m);
  };
  const active = () => mainTab() === "changes";

  // ------------------------------------------------------------ data

  /** Repos the view looks at: the one repo picked (sidebar, Uncommitted changes row), else the repo filter (project level). */
  const scope = createMemo(() => changesScopeRepos());
  /** The single picked repo, only while the project has other repos to hide ("Showing only X"). */
  const focusRepo = createMemo(() => {
    const id = changesRepoId();
    const only = scope();
    return id && projectRepos().length > 1 && only.length === 1 && only[0].id === id ? only[0] : undefined;
  });
  /** Back to the project level view, which follows the repo filter: say so when the filter hides repos. */
  const backLabel = (): string => (isRepoFilterActive() ? "Show repos of the log" : "Show all repos");
  const scopeIds = createMemo(() => scope().map((r) => r.id), [], { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) });

  const [trees, setTrees] = createSignal<Record<string, WorkingTree>>({});
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const seq = new Map<string, number>();
  /** A failed read is tried again a few times by itself (a git lock held for a moment, a repo being rewritten): the banner clears on the first good read. */
  const retrier = createRetrier();
  onCleanup(retrier.cancelAll);

  async function load(repoId: string, attempt = 0): Promise<void> {
    const n = (seq.get(repoId) ?? 0) + 1;
    seq.set(repoId, n);
    try {
      const wt = await api.workingTree(repoId);
      if (seq.get(repoId) !== n) return;
      setTrees((t) => ({ ...t, [repoId]: wt }));
      setErrors((e) => (repoId in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== repoId)) : e));
    } catch (e) {
      if (seq.get(repoId) !== n) return;
      setErrors((x) => ({ ...x, [repoId]: e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e) }));
      // a newer read (an event, the Retry button) takes over
      retrier.schedule(attempt, () => seq.get(repoId) === n && active(), (next) => void load(repoId, next));
    }
  }

  // one loader per repo in scope: reloads on every change of that repo, only while the tab is open
  createMemo(
    mapArray(scopeIds, (id) => {
      createEffect(() => {
        if (!active()) return;
        repoVersion(id);
        workingTreeVersion(id);
        void load(id);
      });
      return id;
    }),
  );

  const shown = createMemo(() => scope().filter((r) => totalFiles(trees()[r.id]) > 0));
  const grouped = () => projectRepos().length > 1;
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set<string>());

  /** Rows of one pane: the Unstaged zone (with Conflicts) and the Staged zone each list the repos that have files in it. */
  const paneRows = (pane: Pane) =>
    createMemo<Row[]>(() =>
      buildRows({
        repos: scope().flatMap((r) => (trees()[r.id] ? [{ repoId: r.id, wt: trees()[r.id] }] : [])),
        grouped: grouped(),
        mode: mode(),
        collapsed: collapsed(),
        pane,
      }),
    );
  const paneRowsOf: Record<Pane, () => Row[]> = { work: paneRows("work"), staged: paneRows("staged") };
  /** Both panes, top to bottom: the order the cursor and the range selection follow. */
  const rows = createMemo<Row[]>(() => [...paneRowsOf.work(), ...paneRowsOf.staged()]);
  const loadedAll = () => scopeIds().every((id) => trees()[id] || errors()[id]);
  const rowIndex = createMemo(() => new Map(rows().map((r, i) => [r.key, i])));
  /** Index of every row inside its own pane (what the pane's list scrolls to). */
  const paneIndex = createMemo(() => new Map(PANES.flatMap((p) => paneRowsOf[p]().map((r, i): [string, number] => [r.key, i]))));
  const paneCount = (pane: Pane): number => scope().reduce((n, r) => {
    const wt = trees()[r.id];
    return wt ? n + (pane === "staged" ? wt.staged.length : wt.unstaged.length + wt.conflicted.length) : n;
  }, 0);

  const toggleCollapsed = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // ------------------------------------------------------------ selection

  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [anchor, setAnchor] = createSignal<string | null>(null);
  const lists: Partial<Record<Pane, VirtualListApi>> = {};
  /** The pane whose list has the keyboard focus. */
  const focusedPane = (): Pane | null => PANES.find((p) => !!lists[p] && lists[p]?.element() === document.activeElement) ?? null;
  /** A range grows inside one pane: the anchor of another pane starts a new selection instead. */
  const inAnchorPane = (key: string): boolean => {
    const a = anchor();
    return !!a && paneOfKey(a) === paneOfKey(key);
  };

  const items = createMemo(() => selectedItems(rows(), selected()));
  const rowByKey = (key: string): Row | undefined => rows()[rowIndex().get(key) ?? -1];

  const showDiff = (row: Row): void => {
    if (row.kind !== "file") return;
    selectFile({
      repoId: row.repoId,
      spec: { kind: row.section === "staged" ? "staged" : "unstaged" },
      path: row.file.path,
      oldPath: row.file.oldPath ?? undefined,
    }, { tab: "changes" });
  };

  const selectOnly = (row: Row): void => {
    setSelected(new Set<string>(isSelectableKey(row.key) ? [row.key] : []));
    setAnchor(row.key);
    setCursor(row.key);
    showDiff(row);
  };

  const click = (row: Row, e: MouseEvent): void => {
    if (row.kind === "repo" || row.kind === "section") {
      setCursor(row.key);
      setAnchor(row.key);
      setSelected(new Set<string>());
      toggleCollapsed(row.key);
      return;
    }
    const additive = e.ctrlKey || e.metaKey;
    if (e.shiftKey && inAnchorPane(row.key)) {
      const range = rangeKeys(rows(), anchor() as string, row.key);
      setSelected(new Set<string>(additive ? [...selected(), ...range] : range));
      setCursor(row.key);
    } else if (additive) {
      const next = new Set(selected());
      if (!next.delete(row.key)) next.add(row.key);
      setSelected(next);
      setAnchor(row.key);
      setCursor(row.key);
    } else {
      selectOnly(row);
    }
  };

  /** Moves the cursor to row `index`; `extend` grows the selection from the anchor (Shift+arrows). */
  const moveTo = (index: number, extend: boolean): void => {
    const rs = rows();
    if (rs.length === 0) return;
    const i = Math.max(0, Math.min(rs.length - 1, index));
    const row = rs[i];
    const pane = paneOfKey(row.key);
    lists[pane]?.scrollToIndex(paneIndex().get(row.key) ?? 0, "auto");
    // the cursor walked into the other zone: the keyboard follows it
    if (focusedPane() && focusedPane() !== pane) lists[pane]?.focus();
    if (extend && inAnchorPane(row.key) && isSelectableKey(row.key)) {
      setSelected(new Set(rangeKeys(rs, anchor() as string, row.key)));
      setCursor(row.key);
    } else if (isSelectableKey(row.key)) {
      selectOnly(row);
    } else {
      setCursor(row.key);
      setAnchor(row.key);
      setSelected(new Set<string>());
    }
  };

  const cursorIndex = () => rowIndex().get(cursor() ?? "") ?? -1;

  const onListKey = (e: KeyboardEvent): void => {
    const rs = rows();
    if (rs.length === 0) return;
    const cur = cursorIndex();
    const page = Math.max(1, Math.floor((lists[focusedPane() ?? "work"]?.element()?.clientHeight ?? 0) / rowH()) - 1);
    const go = (to: number) => {
      e.preventDefault();
      moveTo(to, e.shiftKey);
    };
    switch (e.key) {
      case "ArrowDown": return go(cur + 1);
      case "ArrowUp": return go(cur < 0 ? rs.length - 1 : cur - 1);
      case "PageDown": return go(cur + page);
      case "PageUp": return go(cur - page);
      case "Home": return go(0);
      case "End": return go(rs.length - 1);
      case "ArrowRight":
      case "ArrowLeft": {
        const row = rs[cur];
        if (!row || (row.kind === "file")) return;
        const open = row.kind === "repo" ? !collapsed().has(row.key) : row.open;
        if ((e.key === "ArrowRight") === open) return;
        e.preventDefault();
        toggleCollapsed(row.key);
      }
    }
  };

  /** A reload moved or removed rows: drop vanished keys and move the cursor to the nearest surviving file. */
  createEffect(
    on(rows, (cur, prev) => {
      if (!prev) return;
      const alive = new Set(cur.map((r) => r.key));
      const sel = selected();
      const kept = [...sel].filter((k) => alive.has(k));
      const c = cursor();
      const cursorLost = c !== null && !alive.has(c);
      if (kept.length !== sel.size || cursorLost) {
        if (kept.length === 0 && c !== null && sel.size > 0) {
          const repoId = repoIdOfKey(c);
          // a staged file leaves its zone: prefer the neighbour in the same zone, then any file of the repo
          const oldKeys = prev.map((r) => r.key);
          const inRepo = (k: string) => k.startsWith("f:") && repoIdOfKey(k) === repoId;
          const next = nearestSurvivor(oldKeys, c, alive, (k) => inRepo(k) && paneOfKey(k) === paneOfKey(c)) ?? nearestSurvivor(oldKeys, c, alive, inRepo);
          const row = next ? cur.find((r) => r.key === next) : undefined;
          if (row) selectOnly(row);
          else {
            setSelected(new Set<string>());
            setCursor(null);
            setAnchor(null);
          }
        } else {
          setSelected(new Set(kept));
          if (cursorLost) setCursor(kept[kept.length - 1] ?? null);
          if (anchor() && !alive.has(anchor() as string)) setAnchor(cursor());
        }
      }
    }),
  );

  // The File changes tab follows a file that moved to the other zone (stage, unstage) and shows its new diff; it drops
  // a file that is no longer changed. Once the spec matches the zone this is a no-op, so it cannot loop. This is the
  // file of the Local changes tab, also when the working tree changes while the Log tab is active.
  createEffect(() => {
    const f = fileFor("changes");
    if (!f || f.spec.kind === "commit") return;
    const wt = trees()[f.repoId];
    if (!wt) return;
    const has = (list: readonly { path: string }[]) => list.some((x) => x.path === f.path);
    const section: Section = f.spec.kind === "staged" ? "staged" : "unstaged";
    if (has(sectionFiles(wt, section)) || has(wt.conflicted)) return;
    const other: Section = section === "staged" ? "unstaged" : "staged";
    const moved = sectionFiles(wt, other).find((x) => x.path === f.path);
    if (moved) selectFile({ ...f, spec: { kind: other }, oldPath: moved.oldPath ?? undefined }, { reveal: false, tab: "changes" });
    else selectFile(null, { tab: "changes" });
  });

  // ------------------------------------------------------------ actions

  const allItems = (repoId: string, section: Section): FileItem[] => {
    const wt = trees()[repoId];
    return wt ? sectionFiles(wt, section).map((file) => ({ repoId, section, file })) : [];
  };
  /** What "Stage all" stages in a repo: the unstaged files and, as "mark resolved", the conflicted ones. */
  const repoUnstaged = (repoId: string): FileItem[] => [...allItems(repoId, "unstaged"), ...allItems(repoId, "conflicts")];
  /** Rows an action applies to: the selection when the row is in it, otherwise the row alone. */
  const targets = (row: Row): FileItem[] => (selected().has(row.key) ? items() : rowItems(row));

  const pathsText = (list: FileItem[], absolute: boolean): string =>
    list.map((i) => (absolute ? joinRepoPath(repoById(i.repoId)?.path ?? "", i.file.path) : i.file.path)).join("\n");
  /** True when a repo of the list is unknown: its absolute path cannot be built. */
  const noAbsolute = (list: FileItem[]): boolean => list.some((i) => !repoById(i.repoId)?.path);

  /** The conflicted files a conflict action applies to, by repo. */
  const conflictPaths = (row: Row): Map<string, string[]> => {
    const by = new Map<string, string[]>();
    for (const i of row.kind === "file" || row.kind === "dir" ? targets(row) : []) {
      if (i.section === "conflicts") by.set(i.repoId, [...(by.get(i.repoId) ?? []), i.file.path]);
    }
    return by;
  };
  const acceptConflicts = async (row: Row, side: "ours" | "theirs"): Promise<void> => {
    for (const [repoId, paths] of conflictPaths(row)) await actions.acceptSide(repoId, paths, side);
  };

  /** The file and folder rows the "Add to .gitignore…" item applies to: the selected rows when the row is in the selection, else the row. */
  const ignoreRefs = (row: Row): IgnoreRef[] => {
    const picked = selected().has(row.key) ? rows().filter((r) => selected().has(r.key)) : [row];
    const refs = new Map<string, IgnoreRef>();
    for (const r of picked) {
      if (r.kind === "file") refs.set(`${r.repoId}\0${r.file.path}`, { repoId: r.repoId, path: r.file.path, isDir: false });
      else if (r.kind === "dir") refs.set(`${r.repoId}\0${r.path}/`, { repoId: r.repoId, path: r.path, isDir: true });
    }
    return [...refs.values()];
  };

  /** Files in a "Stash…" selection. */
  const pickCount = (picks: ReturnType<typeof stashFilesOf>): number => Object.values(picks).reduce((n, p) => n + p.count, 0);

  const rowMenu = (row: Row, e: MouseEvent): void => {
    e.preventDefault();
    if (row.kind === "file" || row.kind === "dir") {
      if (!selected().has(row.key)) selectOnly(row);
      else setCursor(row.key);
    }
    const list = row.kind === "file" || row.kind === "dir" ? targets(row) : [];
    const menu: MenuItem[] = [];
    if (row.kind === "file" || row.kind === "dir") {
      const conflicts = list.filter((i) => i.section === "conflicts");
      const plain = list.filter((i) => i.section === "unstaged");
      const staged = list.filter((i) => i.section === "staged");
      const n = (l: FileItem[]) => (l.length > 1 ? ` ${l.length} files` : "");
      if (conflicts.length) {
        if (conflicts.length === 1 && row.kind === "file") {
          menu.push({ label: "Merge…", icon: "merge", onSelect: () => void actions.openMerge(row.repoId, row.file.path) });
          menu.push({ label: "Resolve in editor", icon: "edit", disabled: row.file.status === "deleted", onSelect: () => void actions.editFile(row.repoId, row.file.path) });
        }
        menu.push({ label: `Accept Yours${n(conflicts)}`, icon: "conflict", onSelect: () => void acceptConflicts(row, "ours") });
        menu.push({ label: `Accept Theirs${n(conflicts)}`, icon: "conflict", onSelect: () => void acceptConflicts(row, "theirs") });
        menu.push({ label: `Mark${n(conflicts)} resolved`, icon: "check", onSelect: () => void stageItems(conflicts) });
      }
      if (plain.length) menu.push({ label: `Stage${n(plain)}`, icon: "plus", shortcut: "Space", onSelect: () => void stageItems(plain) });
      if (staged.length) menu.push({ label: `Unstage${n(staged)}`, icon: "minus", shortcut: staged.length === list.length ? "Space" : undefined, onSelect: () => void unstageItems(staged) });
      if (row.kind === "file" && list.length === 1 && row.section !== "conflicts") {
        const gone = row.file.status === "deleted";
        menu.push({ label: "Edit file", icon: "edit", disabled: gone, tooltip: gone ? "The file is deleted from the working tree." : undefined, onSelect: () => void actions.editFile(row.repoId, row.file.path) });
      }
      menu.push({ separator: true });
      const dis = discardable(list);
      menu.push({
        label: `Discard changes${dis.length > 1 ? ` in ${dis.length} files` : ""}…`,
        icon: "undo",
        danger: true,
        shortcut: "Delete",
        disabled: dis.length === 0,
        tooltip: dis.length === 0 ? "Only unstaged and untracked files can be discarded. Unstage staged files first." : undefined,
        onSelect: () => void discardItems(dis),
      });
      const picks = stashFilesOf(list);
      const stashN = pickCount(picks);
      menu.push({
        label: stashN > 1 ? `Stash ${stashN} files…` : "Stash file…",
        icon: "stashPush",
        disabled: stashN === 0,
        tooltip: stashN === 0 ? "Conflicted files cannot be stashed. Resolve them first." : undefined,
        onSelect: () => void actions.stashSave([], picks),
      });
      menu.push({ separator: true });
      menu.push({ label: list.length > 1 ? "Copy paths" : "Copy path", icon: "copy", onSelect: () => void copyText(pathsText(list, false)) });
      menu.push({ label: list.length > 1 ? "Copy absolute paths" : "Copy absolute path", icon: "path", disabled: noAbsolute(list), onSelect: () => void copyText(pathsText(list, true)) });
      menu.push(...ignoreMenuItems(ignoreRefs(row), actions.addToIgnore));
    } else if (row.kind === "section") {
      const all = allItems(row.repoId, row.section);
      if (row.section === "staged") menu.push({ label: "Unstage all", icon: "minus", onSelect: () => void unstageItems(all) });
      else menu.push({ label: row.section === "conflicts" ? "Mark all resolved" : "Stage all", icon: row.section === "conflicts" ? "check" : "plus", onSelect: () => void stageItems(all) });
      if (row.section === "unstaged") menu.push({ label: "Discard all…", icon: "undo", danger: true, onSelect: () => void discardItems(all) });
      menu.push({ separator: true });
      menu.push({ label: row.open ? "Collapse" : "Expand", onSelect: () => toggleCollapsed(row.key) });
    } else {
      const id = row.repoId;
      const unstaged = [...allItems(id, "unstaged"), ...allItems(id, "conflicts")];
      const staged = allItems(id, "staged");
      menu.push({ label: "Stage all", icon: "plus", disabled: unstaged.length === 0, onSelect: () => void stageItems(unstaged) });
      menu.push({ label: "Unstage all", icon: "minus", disabled: staged.length === 0, onSelect: () => void unstageItems(staged) });
      menu.push({ separator: true });
      menu.push({ label: "Stash changes…", icon: "stashPush", onSelect: () => void actions.stashSave([id]) });
      menu.push({ separator: true });
      menu.push(
        focusRepo()
          ? { label: backLabel(), onSelect: () => setChangesRepoId(null) }
          : { label: `Show only ${repoById(id)?.name ?? "this repo"}`, onSelect: () => setChangesRepoId(id) },
      );
      menu.push({ label: collapsed().has(row.key) ? "Expand" : "Collapse", onSelect: () => toggleCollapsed(row.key) });
    }
    openContextMenu(e, menu);
  };

  const ctl: RowCtl = {
    isSelected: (k) => selected().has(k),
    isCursor: (k) => cursor() === k,
    click,
    doubleClick: (row) => {
      if (row.kind === "dir") toggleCollapsed(row.key);
      else if (row.kind === "file" && row.section === "conflicts") void actions.openMerge(row.repoId, row.file.path);
      else showDiff(row);
    },
    context: rowMenu,
    toggle: (row) => toggleCollapsed(row.key),
    // staging or unstaging one file also shows its diff, so the user sees what moves (the effect above follows it)
    tick: (row) => {
      showDiff(row);
      void (row.section === "staged" ? unstageItems(targets(row)) : stageItems(targets(row)));
    },
    stage: (row) => {
      showDiff(row);
      void stageItems(targets(row));
    },
    unstage: (row) => {
      showDiff(row);
      void unstageItems(targets(row));
    },
    discard: (row) => void discardItems(targets(row)),
    acceptSide: (row, side) => void acceptConflicts(row, side),
    merge: (row) => void actions.openMerge(row.repoId, row.file.path),
    sectionStage: (row: SectionRow) => void stageItems(allItems(row.repoId, row.section)),
    sectionUnstage: (row: SectionRow) => void unstageItems(allItems(row.repoId, row.section)),
    sectionDiscard: (row: SectionRow) => void discardItems(allItems(row.repoId, row.section)),
    repoStage: (row: RepoRow) => void stageItems(repoUnstaged(row.repoId)),
    repoUnstage: (row: RepoRow) => void unstageItems(allItems(row.repoId, "staged")),
    repoDiscard: (row: RepoRow) => void discardItems(allItems(row.repoId, "unstaged")),
  };

  // ------------------------------------------------------------ rubber-band selection

  let bandBase: ReadonlySet<string> = new Set<string>();
  let bandMode: MarqueeMode = "replace";
  /** What a band drawn in `pane` does to the selection (the pointer handling is in `PaneList`). */
  const marqueeOf = (pane: Pane): MarqueeHandlers => ({
    begin: (mode) => {
      bandMode = mode;
      bandBase = mode === "replace" ? new Set<string>() : selected();
    },
    update: (indexes) => {
      const list = paneRowsOf[pane]();
      const keys = indexes.map((i) => list[i]?.key).filter((k): k is string => !!k && isSelectableKey(k));
      setSelected(combineSelection(bandBase, keys, bandMode));
      if (keys.length > 0) {
        if (!anchor() || bandMode === "replace") setAnchor(keys[0]);
        setCursor(keys[keys.length - 1]);
      }
    },
    end: () => {
      // like a click on one file: a single file shows its diff
      const only = [...selected()];
      if (only.length !== 1) return;
      const row = rowByKey(only[0]);
      if (row) showDiff(row);
    },
    clickEmpty: (mode) => {
      if (mode === "replace") setSelected(new Set<string>());
    },
  });

  // ------------------------------------------------------------ keyboard

  const listFocused = () => active() && focusedPane() !== null;
  const offs = [
    register("changes.toggleStage", "Space", () => {
      const list = items();
      if (list.length === 0) return false;
      void toggleStage(list);
    }, { title: "Stage or unstage the selected files", group: "Local changes", when: listFocused }),
    register("changes.discard", "Delete", () => {
      if (items().length === 0) return false;
      void discardItems(items());
    }, { title: "Discard the selected files", group: "Local changes", when: listFocused }),
    register("changes.showDiff", "Enter", () => {
      const row = rowByKey(cursor() ?? "");
      if (!row) return false;
      if (row.kind === "file") showDiff(row);
      else toggleCollapsed(row.key);
    }, { title: "Show the diff of the file", group: "Local changes", when: listFocused }),
    register("changes.selectAll", "Ctrl+A", () => {
      // the files of the zone that has the keyboard
      setSelected(new Set<string>(paneRowsOf[focusedPane() ?? "work"]().filter((r) => r.kind === "file").map((r) => r.key)));
    }, { title: "Select all files of the list", group: "Local changes", when: listFocused }),
    register("changes.stageAll", "Ctrl+Alt+A", () => {
      const all = shown().flatMap((r) => repoUnstaged(r.id));
      if (all.length) void stageItems(all);
    }, { title: "Stage all changes", group: "Local changes", when: active }),
  ];
  onCleanup(() => offs.forEach((off) => off()));

  // ------------------------------------------------------------ banners, stash bar, commit box

  const opRepos = createMemo(() => scope().filter((r) => !!OP_LABEL[summary(r.id)?.state ?? "clean"]));
  const stashIds = () => shown().map((r) => r.id);
  /** "Stash" acts on the selected files when there are any, else on every change. */
  const stashSelected = () => items().length > 0;
  const stashPicks = createMemo(() => stashFilesOf(items()));
  const selectedStashCount = () => pickCount(stashPicks());
  const stashTotal = () => scope().reduce((n, r) => n + (summary(r.id)?.stashCount ?? 0), 0);

  const abort = async (id: string): Promise<void> => {
    const state = summary(id)?.state ?? "clean";
    const name = repoById(id)?.name ?? id;
    const label = (OP_LABEL[state] ?? "Operation").toLowerCase();
    const r = await confirmAction({
      title: `Abort ${label}`,
      message: `Abort the ${label} in ${name}? Changes made by the ${label} are lost.`,
      confirmLabel: `Abort ${label}`,
      danger: true,
    });
    if (r) await actions.opAbort(id, { confirmed: true });
  };

  const targetsForCommit = createMemo<CommitTarget[]>(() =>
    shown().flatMap((repo) => {
      const staged = trees()[repo.id]?.staged.length ?? 0;
      return staged > 0 ? [{ repo, staged }] : [];
    }),
  );
  let root: HTMLDivElement | undefined;
  let bodyEl: HTMLDivElement | undefined;

  // Vertical layout: the file list keeps its minimum height, the commit box takes the rest (the message editor shrinks
  // first); a very short island collapses the box to a one-line subject field next to the buttons.
  const [commitH, setCommitH] = createSignal(loadSplitSize("changesCommit", DEFAULT_HEIGHT));
  const [compact, setCompact] = createSignal(false);
  const listMin = () => cssPx("--dg-changes-list-min-height", 120);
  const commitMin = () => cssPx("--dg-changes-commit-min-height", 176);
  /** Height of the rows above the list (focus notice, banners). */
  const chromeH = () => (root ? Array.from(root.children).reduce((n, el) => n + (el.classList.contains("dg-changes-focus") || el.classList.contains("dg-changes-banners") ? (el as HTMLElement).offsetHeight : 0), 0) : 0);
  const maxCommit = () => Math.max(commitMin(), (root?.clientHeight ?? 900) - chromeH() - listMin());

  // The two zones of the file area are always there. The Staged zone has a height of its own (the divider, remembered);
  // the Unstaged zone takes the rest. Until the user drags the divider the two share the area.
  const [bodyH, setBodyH] = createSignal(0);
  const [stagedPref, setStagedPref] = createSignal(loadSplitSize("changesStaged", Number.NaN));
  const paneMin = () => cssPx("--dg-changes-pane-min-height", 76);
  const stagedH = () => stagedHeight(bodyH(), stagedPref(), paneMin());

  const measure = () => {
    setCompact(root ? isCompact(root.clientHeight - chromeH(), listMin(), commitMin()) : false);
    setBodyH(bodyEl?.clientHeight ?? 0);
  };
  onMount(() => {
    if (!root) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    if (bodyEl) ro.observe(bodyEl);
    onCleanup(() => ro.disconnect());
  });

  // last commit time for the clean state
  const [lastCommit] = createResource(
    () => (active() && loadedAll() && rows().length === 0 ? scope().map((r) => ({ id: r.id, oid: summary(r.id)?.headOid ?? null })) : null),
    async (list) => {
      let best: { time: number; repo: string } | null = null;
      await Promise.all(list.map(async (x) => {
        if (!x.oid) return;
        try {
          const d = await api.commitDetails(x.id, x.oid);
          if (!best || d.committer.time > best.time) best = { time: d.committer.time, repo: repoById(x.id)?.name ?? x.id };
        } catch {
          /* no commit time: the hint is optional */
        }
      }));
      return best as { time: number; repo: string } | null;
    },
  );

  const cleanBody = (): string => {
    const n = scope().length;
    return n === 1 ? `${scope()[0].name} has no uncommitted changes.` : `All ${n} repositories have no uncommitted changes.`;
  };

  // ------------------------------------------------------------ the two zones

  const clean = () => loadedAll() && rows().length === 0;
  const unstagedAll = (): FileItem[] => scope().flatMap((r) => repoUnstaged(r.id));
  const discardAll = (): FileItem[] => scope().flatMap((r) => allItems(r.id, "unstaged"));
  const stagedAll = (): FileItem[] => scope().flatMap((r) => allItems(r.id, "staged"));

  const renderRow = (i: number, pane: Pane): JSX.Element => {
    const row = createMemo(() => paneRowsOf[pane]()[i]);
    const as = <K extends Row["kind"]>(kind: K) => (): Extract<Row, { kind: K }> | undefined => {
      const r = row();
      return r?.kind === kind ? (r as Extract<Row, { kind: K }>) : undefined;
    };
    const repoRow = as("repo");
    const sectionRow = as("section");
    const dirRow = as("dir");
    const fileRow = as("file");
    return (
      <>
        <Show when={repoRow()}>{(r) => <RepoRowView row={r()} ctl={ctl} open={!collapsed().has(r().key)} />}</Show>
        <Show when={sectionRow()}>{(r) => <SectionRowView row={r()} ctl={ctl} />}</Show>
        <Show when={dirRow()}>{(r) => <DirRowView row={r() as DirRow} ctl={ctl} />}</Show>
        <Show when={fileRow()}>{(r) => <FileRowView row={r() as FileRow} ctl={ctl} />}</Show>
      </>
    );
  };

  const renderPane = (pane: Pane): JSX.Element => (
    <PaneList
      pane={pane}
      title={PANE_TITLE[pane]}
      count={paneCount(pane)}
      tone={pane === "staged" ? (paneCount(pane) > 0 ? "success" : "neutral") : (scope().some((r) => (trees()[r.id]?.conflicted.length ?? 0) > 0) ? "error" : "neutral")}
      actions={
        pane === "staged" ? (
          <Action icon="minus" label="Unstage all" disabled={stagedAll().length === 0} onClick={() => void unstageItems(stagedAll())} />
        ) : (
          <>
            <Action icon="plus" label="Stage all" shortcut="Ctrl+Alt+A" disabled={unstagedAll().length === 0} onClick={() => void stageItems(unstagedAll())} />
            <Action icon="undo" label="Discard all" danger disabled={discardAll().length === 0} onClick={() => void discardItems(discardAll())} />
          </>
        )
      }
      rows={paneRowsOf[pane]()}
      rowHeight={rowH()}
      loading={!loadedAll()}
      emptyTitle={pane === "staged" ? "Nothing staged" : "No unstaged changes"}
      emptyHint={
        pane === "staged" ? (
          paneRowsOf.work().length > 0 ? "Stage files to put them in the next commit." : undefined
        ) : clean() ? (
          <>
            {cleanBody()}
            <Show when={lastCommit()}>
              {(c) => (
                <>
                  {" "}Last commit <span data-tip={fullDate(c().time)}>{formatDate(c().time)}</span>{scope().length > 1 ? ` in ${c().repo}` : ""}.
                </>
              )}
            </Show>
          </>
        ) : undefined
      }
      ariaLabel={`${PANE_TITLE[pane]} changes`}
      cursorIndex={cursor() && paneOfKey(cursor() as string) === pane ? paneIndex().get(cursor() as string) ?? -1 : -1}
      onKeyDown={onListKey}
      apiRef={(a) => (lists[pane] = a)}
      renderRow={(i) => renderRow(i, pane)}
      marquee={marqueeOf(pane)}
    />
  );

  return (
    <div class="dg-changes" ref={root}>
      <HeaderSlot name="main">
        <Show when={active()}>
          <SegmentedControl<ViewMode>
            label="File layout"
            value={mode()}
            onChange={setMode}
            options={[
              { value: "tree", icon: "tree", title: "Group files by directory" },
              { value: "flat", icon: "list", title: "Flat list of files" },
            ]}
          />
        </Show>
      </HeaderSlot>

      <Show when={focusRepo()}>
        {(r) => (
          <div class="dg-changes-focus">
            <Icon name="filter" size={14} />
            <span>
              Showing only <strong>{r().name}</strong>
            </span>
            <span class="dg-grow" />
            <Button size="small" variant="ghost" onClick={() => setChangesRepoId(null)}>{backLabel()}</Button>
          </div>
        )}
      </Show>

      <Show when={opRepos().length > 0 || Object.keys(errors()).length > 0}>
        <div class="dg-changes-banners">
          <For each={opRepos()}>
            {(repo) => {
              const s = () => summary(repo.id);
              const conflicts = () => s()?.conflicted ?? trees()[repo.id]?.conflicted.length ?? 0;
              const label = () => OP_LABEL[s()?.state ?? "clean"] ?? "Operation";
              const canSkip = () => s()?.state !== "merging";
              return (
                <div class="dg-changes-banner" classList={{ "is-resolved": conflicts() === 0 }} role="status">
                  <Icon name={conflicts() === 0 ? "check" : "conflict"} size={16} class="dg-changes-banner-icon" />
                  <span class="dg-changes-banner-text">
                    <strong>{label()} in progress</strong>
                    <Show when={grouped()}>
                      <span class="dg-changes-banner-repo"> in {repo.name}</span>
                    </Show>
                    <span class="dg-changes-banner-sub">
                      {conflicts() > 0 ? `${plural(conflicts(), "conflicted file")} left. Resolve them, then continue.` : "All conflicts are resolved. Continue to finish."}
                    </span>
                  </span>
                  <Show when={conflicts() > 0}>
                    <Button size="small" variant="primary" title="Open the list of conflicted files" onClick={() => void actions.openConflicts(repo.id)}>Resolve conflicts…</Button>
                  </Show>
                  <Button
                    size="small"
                    variant={conflicts() > 0 ? "default" : "primary"}
                    disabled={conflicts() > 0}
                    title={conflicts() > 0 ? `Resolve ${plural(conflicts(), "conflicted file")} first` : `Continue the ${label().toLowerCase()}`}
                    onClick={() => void actions.opContinue(repo.id)}
                  >
                    Continue
                  </Button>
                  <Show when={canSkip()}>
                    <Button size="small" title={`Skip this step of the ${label().toLowerCase()}`} onClick={() => void actions.opSkip(repo.id)}>Skip</Button>
                  </Show>
                  <Button size="small" variant="danger" title={`Abort the ${label().toLowerCase()}`} onClick={() => void abort(repo.id)}>Abort</Button>
                </div>
              );
            }}
          </For>
          <For each={Object.entries(errors())}>
            {([id, message]) => (
              <div class="dg-changes-banner is-error" role="alert">
                <Icon name="error" size={16} class="dg-changes-banner-icon" />
                <span class="dg-changes-banner-text">
                  <strong>Could not read the changes of {repoById(id)?.name ?? id}</strong>
                  <span class="dg-changes-banner-sub">{message}</span>
                </span>
                <Button size="small" onClick={() => void load(id)}>Retry</Button>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class="dg-changes-body" ref={bodyEl}>
        <div class="dg-changes-zone">{renderPane("work")}</div>
        <div class="dg-changes-zone is-staged" style={{ height: stagedH() + "px" }}>
          <Splitter
            orientation="horizontal"
            reverse
            size={stagedH()}
            onSize={setStagedPref}
            min={paneMin()}
            max={() => Math.max(paneMin(), bodyH() - paneMin())}
            defaultSize={Math.round(bodyH() / 2)}
            persistKey="changesStaged"
          />
          {renderPane("staged")}
        </div>
      </div>

      <CommitBox
        targets={targetsForCommit}
        fallback={() => focusRepo() ?? shown()[0] ?? scope()[0]}
        height={commitH}
        onHeight={setCommitH}
        minHeight={commitMin}
        maxHeight={maxCommit}
        compact={compact}
        aside={
          <>
            <Show when={stashTotal() > 0}>
              <span class="dg-changes-stashcount">{plural(stashTotal(), "stash", "stashes")}</span>
            </Show>
            <Button
              size="small"
              variant="ghost"
              icon="stashPush"
              disabled={stashSelected() ? selectedStashCount() === 0 : stashIds().length === 0}
              title={
                stashSelected()
                  ? selectedStashCount() === 0
                    ? "Conflicted files cannot be stashed. Resolve them first."
                    : "Stash only the selected files and ask for a message"
                  : stashIds().length === 0
                    ? "No local changes to stash"
                    : "Stash all local changes and clean the working tree. Select files to stash only those."
              }
              shortcut="Ctrl+Alt+Z"
              onClick={() => void (stashSelected() ? actions.stashSave([], stashPicks()) : actions.stashSave(stashIds()))}
            >
              {stashSelected() ? (selectedStashCount() > 0 ? `Stash ${plural(selectedStashCount(), "file")}…` : "Stash selected…") : "Stash changes"}
            </Button>
          </>
        }
      />
    </div>
  );
}
