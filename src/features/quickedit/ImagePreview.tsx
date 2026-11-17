/**
 * The picture of a working tree file, for the quick editor (a binary file cannot be edited). One `<img>` on a Blob URL,
 * so a GIF animates and an SVG renders. The bytes come from `api.fileImages` (the working tree side of an unstaged diff);
 * the sizes and the decoding helpers are the ones of the image diff (`features/diff/imageModel.ts`).
 */
import { type JSX, Match, Show, Switch, createEffect, createSignal, onCleanup } from "solid-js";
import * as api from "../../api/tauri";
import { toApiError } from "../../api/tauri";
import type { ImageSide } from "../../api/types";
import { Button, EmptyState, Icon, Spinner } from "../../components/ui";
import { base64ToBytes, dimensionsLabel, formatBytes, hasBytes, naturalSize, type Size } from "../diff/imageModel";

export function ImagePreview(props: { repoId: string; path: string }): JSX.Element {
  const [side, setSide] = createSignal<ImageSide | null>(null);
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [error, setError] = createSignal("");
  const [retry, setRetry] = createSignal(0);
  const [url, setUrl] = createSignal<string | null>(null);
  const [dim, setDim] = createSignal<Size | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [actual, setActual] = createSignal(false);

  createEffect(() => {
    const { repoId, path } = props;
    retry();
    let live = true;
    setStatus("loading");
    api.fileImages(repoId, { kind: "unstaged" }, path).then(
      (r) => {
        if (!live) return;
        setSide(r.new);
        setStatus("ready");
      },
      (e: unknown) => {
        if (!live) return;
        setError(toApiError(e).message);
        setStatus("error");
      },
    );
    onCleanup(() => (live = false));
  });

  // A Blob URL for the side; the size of the picture is known once the browser has decoded it. The URL is revoked when the side changes.
  createEffect(() => {
    const s = side();
    setUrl(null);
    setDim(null);
    setFailed(false);
    if (!hasBytes(s)) return;
    const u = URL.createObjectURL(new Blob([base64ToBytes(s.data) as BlobPart], { type: s.mime }));
    let live = true;
    const probe = new Image();
    probe.onload = () => {
      if (!live) return;
      setDim(naturalSize(probe.naturalWidth, probe.naturalHeight));
      setUrl(u);
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

  /** The natural size of the picture while "Actual size" is on; otherwise the style sheet fits it to the window. */
  const actualSize = (): JSX.CSSProperties | undefined => {
    const d = dim();
    return actual() && d ? { width: d.w + "px", height: d.h + "px" } : undefined;
  };

  return (
    <Switch>
      <Match when={status() === "loading"}>
        <div class="dg-qe-state">
          <Spinner />
          <p>Loading the picture…</p>
        </div>
      </Match>
      <Match when={status() === "error"}>
        <div class="dg-qe-state" role="alert">
          <Icon name="error" size={20} />
          <p class="dg-selectable">{error()}</p>
          <Button onClick={() => setRetry((n) => n + 1)}>Retry</Button>
        </div>
      </Match>
      <Match when={!side()}>
        <EmptyState icon="fileImage" title="No picture">
          This file is not in the working tree.
        </EmptyState>
      </Match>
      <Match when={side()?.tooLarge}>
        <EmptyState icon="fileImage" title="Too large to preview">
          {`This picture is ${formatBytes(side()?.size ?? 0)}. The preview limit is 20 MB.`}
        </EmptyState>
      </Match>
      <Match when={failed()}>
        <EmptyState icon="fileBinary" title="Binary file — cannot be edited here">
          The browser cannot show this picture.
        </EmptyState>
      </Match>
      <Match when={true}>
        <div class="dg-qe-image">
          <div class="dg-qe-image-view" classList={{ "is-actual": actual() }}>
            <Show when={url()} fallback={<Spinner />}>
              {(u) => (
                <img
                  class="dg-qe-image-img dg-imgdiff-checker"
                  src={u()}
                  alt={props.path}
                  draggable={false}
                  style={actualSize()}
                />
              )}
            </Show>
          </div>
          <div class="dg-qe-image-bar">
            <span class="dg-qe-image-info">
              <Show when={dim()}>{(d) => <span>{dimensionsLabel(d())}</span>}</Show>
              <Show when={side()}>{(s) => <span>{formatBytes(s().size)}</span>}</Show>
              <Show when={side()}>{(s) => <span>{s().mime}</span>}</Show>
            </span>
            <Button size="small" variant="ghost" onClick={() => setActual(!actual())}>
              {actual() ? "Fit to window" : "Actual size"}
            </Button>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
