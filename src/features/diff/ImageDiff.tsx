/**
 * Image diff: shows the two versions of a picture instead of a text diff (png, jpg, gif, webp, bmp, svg, ico, avif).
 * Modes: Side by side, Swipe (draggable divider), Onion skin (opacity slider). An added or deleted file, or a side that
 * cannot be compared, gets the plain single view. Pictures are plain `<img>` elements on Blob URLs, so a GIF animates.
 * The bytes come from `api.fileImages`; the maths is in `imageModel.ts`.
 *
 *   <ImageDiff repoId={id} spec={{ kind: "commit", oid }} path="docs/logo.png" />
 */
import { type Accessor, type JSX, Match, Show, Switch, batch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import * as api from "../../api/tauri";
import type { DiffSpec, FileImages, ImageSide } from "../../api/types";
import { Button, EmptyState, IconButton, SegmentedControl, Spinner } from "../../components/ui";
import { repoVersion } from "../../state/events";
import { cssPx } from "../../state/metrics";
import { imageMode, setImageMode } from "./diffPrefs";
import {
  base64ToBytes, canCompare, clampPercent, dimensionsLabel, fitScale, formatBytes, formatSizeDelta, hasBytes, imageChange, naturalSize,
  stepZoom, swipeFromPointer, unionSize, zoomLabel, type ImageChange, type Size,
} from "./imageModel";

export interface ImageDiffProps {
  repoId: string;
  spec: DiffSpec;
  path: string;
  oldPath?: string;
  /** Called with what the two sides say about the change, so the viewer can show the right status letter. */
  onChange?: (change: ImageChange | null) => void;
}

/** Names of the two sides: what the user compares. */
function sideNames(spec: DiffSpec): { before: string; after: string } {
  if (spec.kind === "commit") return { before: "Parent", after: "This commit" };
  if (spec.kind === "staged") return { before: "HEAD", after: "Index" };
  return { before: "Index", after: "Working tree" };
}

interface Loaded {
  url: Accessor<string | null>;
  dim: Accessor<Size | null>;
  failed: Accessor<boolean>;
}

/** A Blob URL for the side, with the size of the picture once the browser has decoded it. The URL is revoked when the side changes. */
function useImage(side: Accessor<ImageSide | null>): Loaded {
  const [url, setUrl] = createSignal<string | null>(null);
  const [dim, setDim] = createSignal<Size | null>(null);
  const [failed, setFailed] = createSignal(false);
  createEffect(() => {
    const s = side();
    batch(() => {
      setUrl(null);
      setDim(null);
      setFailed(false);
    });
    if (!hasBytes(s)) return;
    const u = URL.createObjectURL(new Blob([base64ToBytes(s.data) as BlobPart], { type: s.mime }));
    let live = true;
    const probe = new Image();
    probe.onload = () => {
      if (!live) return;
      batch(() => {
        setDim(naturalSize(probe.naturalWidth, probe.naturalHeight));
        setUrl(u);
      });
    };
    probe.onerror = () => {
      if (live) setFailed(true);
    };
    probe.src = u;
    onCleanup(() => {
      live = false;
      probe.onload = null;
      probe.onerror = null;
      URL.revokeObjectURL(u);
    });
  });
  return { url, dim, failed };
}

/** Same file: a reload with the same bytes must not rebuild the pictures (a GIF would restart). */
const sameSide = (a: ImageSide | null, b: ImageSide | null): boolean =>
  a === b || (!!a && !!b && a.size === b.size && a.mime === b.mime && a.tooLarge === b.tooLarge && a.data === b.data);

export function ImageDiff(props: ImageDiffProps): JSX.Element {
  const [images, setImages] = createSignal<FileImages | null>(null);
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [error, setError] = createSignal("");
  const [retry, setRetry] = createSignal(0);
  const [fit, setFit] = createSignal(true);
  const [zoom, setZoom] = createSignal(1);
  const [swipe, setSwipe] = createSignal(50);
  const [onion, setOnion] = createSignal(50);
  const [stage, setStage] = createSignal<Size>({ w: 0, h: 0 });
  let loadedKey = "";
  let seq = 0;

  // ---------------------------------------------------------------- loading

  createEffect(() => {
    const { repoId, spec, path } = props;
    const oldPath = props.oldPath ?? null;
    repoVersion(repoId);
    retry();
    const key = `${repoId}\u0000${JSON.stringify(spec)}\u0000${path}\u0000${oldPath ?? ""}`;
    const mine = ++seq;
    untrack(() => {
      if (key === loadedKey) return;
      batch(() => {
        setImages(null);
        setError("");
        setStatus("loading");
        setFit(true);
        setSwipe(50);
        setOnion(50);
      });
    });
    api.fileImages(repoId, spec, path, oldPath).then(
      (r) => {
        if (mine !== seq) return;
        batch(() => {
          loadedKey = key;
          setImages(r);
          setStatus("ready");
        });
      },
      (e: unknown) => {
        if (mine !== seq) return;
        batch(() => {
          loadedKey = "";
          setImages(null);
          setError(e instanceof Object && "message" in e ? String((e as { message: unknown }).message) : String(e));
          setStatus("error");
        });
      },
    );
  });

  const change = createMemo<ImageChange | null>(() => {
    const i = images();
    return i ? imageChange(i) : null;
  });
  createEffect(() => props.onChange?.(change()));
  onCleanup(() => props.onChange?.(null));

  // The memos keep the same side while a reload brings the same bytes, so the pictures stay as they are.
  const oldSide = createMemo(() => images()?.old ?? null, null, { equals: sameSide });
  const newSide = createMemo(() => images()?.new ?? null, null, { equals: sameSide });
  const before = useImage(oldSide);
  const after = useImage(newSide);

  const comparable = createMemo(() => {
    const i = images();
    return !!i && canCompare(i, { old: before.failed(), new: after.failed() });
  });
  const mode = () => (comparable() ? imageMode() : "sideBySide");
  const names = createMemo(() => sideNames(props.spec));

  // ---------------------------------------------------------------- size and zoom

  let viewEl: HTMLDivElement | undefined;
  let observer: ResizeObserver | undefined;
  // A hidden tab measures 0: keep the last real size, so the zoom does not jump when the tab comes back.
  const measure = () => {
    if (viewEl && viewEl.clientWidth > 0 && viewEl.clientHeight > 0) setStage({ w: viewEl.clientWidth, h: viewEl.clientHeight });
  };
  onMount(() => {
    observer = new ResizeObserver(measure);
    if (viewEl) observer.observe(viewEl);
    measure();
  });
  onCleanup(() => observer?.disconnect());
  const attachView = (el: HTMLDivElement) => {
    viewEl = el;
    observer?.disconnect();
    observer?.observe(el);
    measure();
  };

  const pad = () => cssPx("--dg-space-5", 12);
  const union = createMemo(() => unionSize(before.dim(), after.dim()));
  const scale = createMemo(() => {
    if (!fit()) return zoom();
    const p = pad() * 2;
    return fitScale(union(), { w: stage().w - p, h: stage().h - p });
  });
  const zoomBy = (dir: 1 | -1) => {
    const next = stepZoom(scale(), dir);
    batch(() => {
      setZoom(next);
      setFit(false);
    });
  };
  const actualSize = () =>
    batch(() => {
      setZoom(1);
      setFit(false);
    });

  const px = (n: number) => Math.round(n * scale()) + "px";
  const imgStyle = (d: Size | null): JSX.CSSProperties =>
    d ? { width: px(d.w), height: px(d.h), "image-rendering": scale() > 1 ? "pixelated" : "auto" } : {};

  // ---------------------------------------------------------------- panes

  // The two panes of the side by side view scroll together.
  let paneL: HTMLDivElement | undefined;
  let paneR: HTMLDivElement | undefined;
  let syncing = false;
  const syncScroll = (from: HTMLDivElement | undefined, to: HTMLDivElement | undefined) => {
    if (!from || !to || syncing) return;
    syncing = true;
    to.scrollLeft = from.scrollLeft;
    to.scrollTop = from.scrollTop;
    queueMicrotask(() => (syncing = false));
  };

  const caption = (label: string, source: string, side: ImageSide | null, load: Loaded, other?: ImageSide | null) => (
    <div class="dg-imgdiff-cap">
      <span class="dg-imgdiff-cap-label">{label}</span>
      <span class="dg-imgdiff-cap-source">{source}</span>
      <span class="dg-imgdiff-cap-info">
        <Show when={load.dim()}>{(d) => <span>{dimensionsLabel(d())}</span>}</Show>
        <Show when={side}>{(s) => <span>{formatBytes(s().size)}</span>}</Show>
        <Show when={side && other && side.size !== other.size}>
          <span class="dg-imgdiff-delta">{formatSizeDelta(other?.size ?? 0, side?.size ?? 0)}</span>
        </Show>
      </span>
    </div>
  );

  /** The picture of one side, or the reason there is none. */
  const picture = (side: ImageSide | null, load: Loaded) => (
    <Switch>
      <Match when={!side}>
        <div class="dg-imgdiff-note">No file on this side</div>
      </Match>
      <Match when={side?.tooLarge}>
        <div class="dg-imgdiff-note" role="status">
          Too large to preview ({formatBytes(side?.size ?? 0)}, the limit is 20 MB)
        </div>
      </Match>
      <Match when={load.failed()}>
        <div class="dg-imgdiff-note" role="status">
          The browser cannot show this image
        </div>
      </Match>
      <Match when={load.url() && load.dim()}>
        <div class="dg-imgdiff-canvas dg-imgdiff-checker" style={{ width: px(load.dim()?.w ?? 0), height: px(load.dim()?.h ?? 0) }}>
          <img class="dg-imgdiff-img" src={load.url() ?? ""} alt="" draggable={false} style={imgStyle(load.dim())} />
        </div>
      </Match>
      <Match when={true}>
        <div class="dg-imgdiff-note">
          <Spinner />
        </div>
      </Match>
    </Switch>
  );

  /** One pane: caption, then the scrolling view. */
  const pane = (which: "l" | "r" | "one", label: string, source: string, side: ImageSide | null, load: Loaded, other?: ImageSide | null) => (
    <div class="dg-imgdiff-pane">
      {caption(label, source, side, load, other)}
      <div
        class="dg-imgdiff-view"
        tabindex={0}
        ref={(el) => {
          if (which === "r") paneR = el;
          else {
            paneL = el;
            attachView(el);
          }
        }}
        onScroll={(e) => {
          if (which === "l") syncScroll(e.currentTarget, paneR);
          else if (which === "r") syncScroll(e.currentTarget, paneL);
        }}
      >
        {picture(side, load)}
      </div>
    </div>
  );

  // ---------------------------------------------------------------- swipe and onion

  const box = () => ({ width: px(union().w), height: px(union().h) });
  const layer = (load: Loaded, style?: JSX.CSSProperties) => (
    <div class="dg-imgdiff-layer" style={style}>
      <Show when={load.url()}>
        {(u) => <img class="dg-imgdiff-img dg-imgdiff-img-center" src={u()} alt="" draggable={false} style={imgStyle(load.dim())} />}
      </Show>
    </div>
  );

  let swipeBox: HTMLDivElement | undefined;
  const moveSwipe = (e: PointerEvent) => {
    if (!swipeBox) return;
    const r = swipeBox.getBoundingClientRect();
    setSwipe(swipeFromPointer(e.clientX, r.left, r.width));
  };
  const onSwipeDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    swipeBox?.setPointerCapture(e.pointerId);
    moveSwipe(e);
    e.preventDefault();
  };
  const onSwipeMove = (e: PointerEvent) => {
    if (swipeBox?.hasPointerCapture(e.pointerId)) moveSwipe(e);
  };
  const onSwipeKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const next = e.key === "ArrowLeft" ? swipe() - step : e.key === "ArrowRight" ? swipe() + step : e.key === "Home" ? 0 : e.key === "End" ? 100 : null;
    if (next === null) return;
    setSwipe(clampPercent(next));
    e.preventDefault();
  };

  const comparePane = (kind: "swipe" | "onion") => (
    <div class="dg-imgdiff-pane">
      <div class="dg-imgdiff-view" tabindex={-1} ref={(el) => attachView(el)}>
        <div class="dg-imgdiff-box dg-imgdiff-checker" ref={(el) => kind === "swipe" && (swipeBox = el)} style={box()}
          classList={{ "is-swipe": kind === "swipe" }}
          onPointerDown={kind === "swipe" ? onSwipeDown : undefined}
          onPointerMove={kind === "swipe" ? onSwipeMove : undefined}
        >
          <Show
            when={kind === "swipe"}
            fallback={
              <>
                {layer(before)}
                {layer(after, { opacity: String(onion() / 100) })}
              </>
            }
          >
            {layer(before, { "clip-path": `inset(0 ${100 - swipe()}% 0 0)` })}
            {layer(after, { "clip-path": `inset(0 0 0 ${swipe()}%)` })}
            <div
              class="dg-imgdiff-divider"
              role="slider"
              tabindex={0}
              aria-label="Swipe divider"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(swipe())}
              aria-valuetext={`${Math.round(swipe())} % before`}
              style={{ left: swipe() + "%" }}
              onKeyDown={onSwipeKey}
            >
              <span class="dg-imgdiff-grip" />
            </div>
          </Show>
        </div>
      </div>
    </div>
  );

  // ---------------------------------------------------------------- body

  const infoBar = () => (
    <div class="dg-imgdiff-info">
      <span class="dg-imgdiff-info-side">
        <b>Before</b> {names().before}
        <Show when={before.dim()}>{(d) => <span>{dimensionsLabel(d())}</span>}</Show>
        <Show when={oldSide()}>{(s) => <span>{formatBytes(s().size)}</span>}</Show>
      </span>
      <span class="dg-imgdiff-info-side">
        <b>After</b> {names().after}
        <Show when={after.dim()}>{(d) => <span>{dimensionsLabel(d())}</span>}</Show>
        <Show when={newSide()}>{(s) => <span>{formatBytes(s().size)}</span>}</Show>
        <Show when={oldSide() && newSide() && oldSide()?.size !== newSide()?.size}>
          <span class="dg-imgdiff-delta">{formatSizeDelta(oldSide()?.size ?? 0, newSide()?.size ?? 0)}</span>
        </Show>
      </span>
    </div>
  );

  const toolbar = () => (
    <div class="dg-imgdiff-bar">
      <Show when={change() === "modified" && comparable()}>
        <SegmentedControl
          label="Image comparison"
          value={imageMode()}
          onChange={setImageMode}
          options={[
            { value: "sideBySide", label: "Side by side", icon: "sideBySide", title: "Before and after next to each other" },
            { value: "swipe", label: "Swipe", title: "Drag the divider between before and after" },
            { value: "onion", label: "Onion skin", title: "Blend after over before" },
          ]}
        />
      </Show>
      <Show when={mode() === "onion"}>
        <label class="dg-imgdiff-onion">
          <span>Before</span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={onion()}
            aria-label="Opacity of the after image"
            onInput={(e) => setOnion(Number(e.currentTarget.value))}
          />
          <span>After {onion()} %</span>
        </label>
      </Show>
      <span class="dg-imgdiff-grow" />
      <span class="dg-imgdiff-zoom">
        <IconButton icon="maximize" label="Fit to pane" size="small" iconSize={14} active={fit()} onClick={() => setFit(!fit())} />
        <IconButton icon="minus" label="Zoom out" size="small" iconSize={14} onClick={() => zoomBy(-1)} />
        <Button size="small" variant="ghost" class="dg-imgdiff-zoom-label" title="Actual size (100 %)" onClick={actualSize}>
          {zoomLabel(scale())}
        </Button>
        <IconButton icon="plus" label="Zoom in" size="small" iconSize={14} onClick={() => zoomBy(1)} />
      </span>
    </div>
  );

  return (
    <div class="dg-imgdiff" data-mode={mode()}>
      <Switch>
        <Match when={status() === "error"}>
          <EmptyState
            icon="error"
            title="Could not load the image"
            actions={
              <Button size="small" icon="refresh" onClick={() => setRetry(retry() + 1)}>
                Try again
              </Button>
            }
          >
            {error()}
          </EmptyState>
        </Match>
        <Match when={status() === "loading" && !images()}>
          <div class="dg-diff-center" role="status">
            <Spinner />
            <span>Loading image…</span>
          </div>
        </Match>
        <Match when={change() === "none"}>
          <EmptyState icon="fileImage" title="No image to show">
            This file is not in either version.
          </EmptyState>
        </Match>
        <Match when={images()}>
          {toolbar()}
          <div class="dg-imgdiff-stage" classList={{ "is-sbs": mode() === "sideBySide" && change() === "modified" }}>
            <Switch>
              <Match when={change() === "added"}>{pane("one", "Added", names().after, newSide(), after)}</Match>
              <Match when={change() === "deleted"}>{pane("one", "Deleted", names().before, oldSide(), before)}</Match>
              <Match when={mode() === "swipe"}>{comparePane("swipe")}</Match>
              <Match when={mode() === "onion"}>{comparePane("onion")}</Match>
              <Match when={true}>
                {pane("l", "Before", names().before, oldSide(), before, newSide())}
                {pane("r", "After", names().after, newSide(), after, oldSide())}
              </Match>
            </Switch>
          </div>
          <Show when={change() === "modified" && mode() !== "sideBySide"}>{infoBar()}</Show>
        </Match>
      </Switch>
    </div>
  );
}
