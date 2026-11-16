/**
 * One of the two zones of the Local changes tab (Unstaged on top, Staged below): a header with the title, the file
 * count and the zone actions, the virtual list, an empty state that keeps the zone's height, and the rubber-band
 * selection. The pointer handling of the band lives here; what it selects is the view's business (`MarqueeHandlers`).
 */
import { type JSX, Show, createSignal, onCleanup } from "solid-js";
import { Badge, Spinner, VirtualList, type VirtualListApi } from "../../components/ui";
import { autoScrollDelta, marqueeMode, passedThreshold, rectBetween, rowsInRect, type MarqueeMode } from "./marquee";
import type { Pane, Row } from "./model";

/** Presses that start on these never draw a band: they are the row's own buttons. */
const OWN_CONTROLS = ".dg-changes-tick, .dg-changes-actions, .dg-changes-chev-hit";

export interface MarqueeHandlers {
  /** The press turned into a drag: take the selection to start from (the current one with Shift or Ctrl, else none). */
  begin: (mode: MarqueeMode) => void;
  /** Indexes (of this pane's rows) the band touches now. */
  update: (indexes: readonly number[]) => void;
  /** The button was released after a drag. */
  end: () => void;
  /** A press and release on empty space or on a row-less area, without a drag. */
  clickEmpty: (mode: MarqueeMode) => void;
}

export interface PaneListProps {
  pane: Pane;
  title: string;
  /** Files in the pane (the header badge). */
  count: number;
  tone: "neutral" | "success" | "error";
  /** Header buttons, at the right. */
  actions: JSX.Element;
  rows: readonly Row[];
  rowHeight: number;
  /** The working tree has not been read yet. */
  loading: boolean;
  emptyTitle: string;
  emptyHint?: JSX.Element;
  ariaLabel: string;
  cursorIndex: number;
  onKeyDown: (e: KeyboardEvent) => void;
  apiRef: (api: VirtualListApi) => void;
  renderRow: (index: number) => JSX.Element;
  marquee: MarqueeHandlers;
}

interface Band {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Visible size of the list: the band is clipped to it. */
  viewW: number;
  viewH: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function PaneList(props: PaneListProps): JSX.Element {
  let scroller: HTMLElement | undefined;
  const [band, setBand] = createSignal<Band | null>(null);
  // Ends the drag in progress; also run when the pane goes away in the middle of one.
  let stopDrag: (() => void) | undefined;
  onCleanup(() => stopDrag?.());

  const onDown = (e: PointerEvent): void => {
    const el = scroller;
    if (e.button !== 0 || !el || stopDrag) return;
    const target = e.target as HTMLElement;
    if (target.closest(OWN_CONTROLS)) return;
    const box = el.getBoundingClientRect();
    // the scrollbars are not list space
    if (e.clientX - box.left >= el.clientWidth || e.clientY - box.top >= el.clientHeight) return;
    const mode = marqueeMode({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    const onRow = !!target.closest(".dg-vlist-row");
    // where the press happened, in content coordinates: the band stays attached to the rows while the list scrolls
    const ax = e.clientX - box.left + el.scrollLeft;
    const ay = e.clientY - box.top + el.scrollTop;
    const startX = e.clientX;
    const startY = e.clientY;
    let px = startX;
    let py = startY;
    let started = false;
    let raf = 0;

    const update = (): void => {
      const b = el.getBoundingClientRect();
      const vx = clamp(px - b.left, 0, el.clientWidth);
      const vy = clamp(py - b.top, 0, el.clientHeight);
      const r = rectBetween(ax, ay, vx + el.scrollLeft, vy + el.scrollTop);
      setBand({ left: r.left - el.scrollLeft, top: r.top - el.scrollTop, width: r.right - r.left, height: r.bottom - r.top, viewW: el.clientWidth, viewH: el.clientHeight });
      props.marquee.update(rowsInRect(r, props.rowHeight, props.rows.length));
    };
    const tick = (): void => {
      const b = el.getBoundingClientRect();
      const d = autoScrollDelta(py, b.top, b.bottom);
      if (d !== 0) {
        const before = el.scrollTop;
        el.scrollTop += d;
        if (el.scrollTop !== before) update();
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent): void => {
      px = ev.clientX;
      py = ev.clientY;
      if (!started) {
        if (!passedThreshold(px - startX, py - startY)) return;
        started = true;
        props.marquee.begin(mode);
        raf = requestAnimationFrame(tick);
      }
      ev.preventDefault();
      update();
    };
    const finish = (ev: PointerEvent | null): void => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      cancelAnimationFrame(raf);
      stopDrag = undefined;
      setBand(null);
      if (started) {
        props.marquee.end();
        // the click that follows the release must not reach the row the drag ended on
        const swallow = (c: MouseEvent): void => c.stopPropagation();
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      } else if (ev && ev.type === "pointerup" && !onRow) {
        props.marquee.clickEmpty(mode);
      }
    };
    stopDrag = () => finish(null);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
  };

  return (
    <section class="dg-changes-pane" classList={{ "is-staged": props.pane === "staged" }} aria-label={props.title}>
      <header class="dg-changes-pane-head">
        <span class="dg-changes-pane-title" classList={{ "is-staged": props.pane === "staged" }}>{props.title}</span>
        <Badge tone={props.tone}>{props.count}</Badge>
        <span class="dg-grow" />
        <span class="dg-changes-pane-actions">{props.actions}</span>
      </header>
      <div class="dg-changes-pane-body" onPointerDown={onDown}>
        <VirtualList
          class="dg-changes-list"
          role="tree"
          ariaLabel={props.ariaLabel}
          count={props.rows.length}
          rowHeight={props.rowHeight}
          selectedIndex={props.cursorIndex}
          onKeyDown={props.onKeyDown}
          apiRef={(a) => {
            scroller = a.element();
            props.apiRef(a);
          }}
          renderRow={props.renderRow}
        />
        <Show when={props.rows.length === 0}>
          <div class="dg-changes-pane-empty">
            <Show when={!props.loading} fallback={<Spinner />}>
              <span class="dg-changes-pane-empty-title">{props.emptyTitle}</span>
              <Show when={props.emptyHint}>
                <span class="dg-changes-pane-empty-hint">{props.emptyHint}</span>
              </Show>
            </Show>
          </div>
        </Show>
        <Show when={band()}>
          {(b) => (
            <div class="dg-changes-marquee-clip" style={{ width: b().viewW + "px", height: b().viewH + "px" }} aria-hidden="true">
              <div class="dg-changes-marquee" style={{ left: b().left + "px", top: b().top + "px", width: b().width + "px", height: b().height + "px" }} />
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}
