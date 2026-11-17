/**
 * The quick editor (dialog "quickEdit"): a modal to change one working tree file, like the "Edit file" of GitHub or
 * GitLab. It is for a README or a config file, not for coding. The text has line numbers, the syntax colours of the diff
 * viewer, find and replace, and keeps its line breaks (LF or CRLF). Save writes the file and closes the dialog; the
 * backend sends `repo-changed`, so the changes list and the diff refresh by themselves.
 *
 * A conflicted file (or one that holds conflict markers) also gets the hunk resolver of `conflictEditor.ts`: Accept
 * Yours / Theirs / both above each hunk, a bar with the number of conflicts left, and "Mark as resolved", which saves
 * the file and stages it only when no marker is left.
 *
 * The save sends the version that the file had when it was read. If the file changed on disk meanwhile, the user chooses
 * between overwriting it and reloading it. A picture (png, gif, webp...) shows as a picture, any other binary file and a
 * file over 2 MiB show a note: the backend does not send their content.
 *
 * The dialog is loaded on demand (`features/dialogs/index.ts`), because it pulls in the editor.
 */
import { type JSX, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import type { EditorState, Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import * as api from "../../api/tauri";
import { toApiError } from "../../api/tauri";
import type { TextFile } from "../../api/types";
import { isImagePath } from "../../api/imageFiles";
import { Button, Dialog, EmptyState, Icon, IconButton, RepoChip, Spinner, fileIconFor, openDialog, plural, splitPath, toast, type DialogComponentProps } from "../../components/ui";
import * as actions from "../../state/actions";
import { type QuickEditProps, confirmAction } from "../../state/dialogs";
import { trackOverlay } from "../../state/keymap";
import { projectRepos, repoById, summary } from "../../state/workspace";
import { conflictCount, goToConflict, setConflictMode } from "./conflictEditor";
import { createFileState, saveText } from "./editor";
import { openFind } from "./find/panel";
import { ImagePreview } from "./ImagePreview";
import { isStaleVersion, languageLabel, lineEndLabel } from "./model";
import "./quickedit.css";

type Phase = "loading" | "text" | "image" | "binary" | "tooLarge" | "error";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), .cm-content';

/** Asks what to do with a file that changed on disk after the editor read it. */
function ChangedOnDisk(props: { name: string } & DialogComponentProps<"overwrite" | "reload">): JSX.Element {
  return (
    <Dialog
      title="The file changed on disk."
      onClose={() => props.close()}
      primary={{ label: "Overwrite", danger: true, onClick: () => props.close("overwrite") }}
      footerLeft={<Button onClick={() => props.close("reload")}>Reload</Button>}
    >
      <p class="dg-selectable" style={{ "line-height": "18px" }}>
        {`${props.name} changed on disk after you opened it. Overwrite the file with your text, or reload it and lose your changes.`}
      </p>
    </Dialog>
  );
}

/** The CodeMirror view. It mounts once the text is read; the dialog gets the view through `onView`. */
function TextSurface(props: { state: EditorState; onView: (v: EditorView) => void }): JSX.Element {
  let host: HTMLDivElement | undefined;
  onMount(() => {
    const view = new EditorView({ parent: host, state: props.state });
    props.onView(view);
    view.focus();
    onCleanup(() => view.destroy());
  });
  return <div class="dg-qe-editor" ref={host} />;
}

export function QuickEditDialog(props: QuickEditProps & DialogComponentProps<void>): JSX.Element {
  let box: HTMLDivElement | undefined;
  const previous = document.activeElement as HTMLElement | null;
  trackOverlay(() => true);

  const split = splitPath(props.path);
  const repo = () => repoById(props.repoId);

  const [phase, setPhase] = createSignal<Phase>("loading");
  const [error, setError] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [cursor, setCursor] = createSignal({ line: 1, column: 1 });
  const [lineEnd, setLineEnd] = createSignal<"LF" | "CRLF">("LF");
  const [conflicted, setConflicted] = createSignal(false);
  const [conflicts, setConflicts] = createSignal(0);
  const [initial, setInitial] = createSignal<EditorState | null>(null);
  let view: EditorView | undefined;
  /** The document as it is on disk. The editor is dirty when its document differs. */
  let saved: Text | undefined;
  /** The version of the file on disk that the editor read or wrote last. */
  let version = "";
  let closing = false;

  const onUpdate = (u: ViewUpdate): void => {
    if (u.docChanged) setDirty(!!saved && !u.state.doc.eq(saved));
    if (u.docChanged || u.selectionSet) {
      const head = u.state.selection.main.head;
      const line = u.state.doc.lineAt(head);
      setCursor({ line: line.number, column: head - line.from + 1 });
    }
    if (u.docChanged) setConflicts(conflictCount(u.state));
  };

  /** Puts the text of a read file into the editor (a new editor state, so the undo history starts again). */
  const showText = (f: TextFile, isConflicted: boolean): void => {
    let st = createFileState(f.content, props.path, onUpdate);
    // The hunk resolver is on for a conflicted file and for a text that holds a conflict marker.
    // During a rebase the first section of a hunk is Theirs (the branch rebased onto).
    const on = isConflicted || /^<{7}( |$)/m.test(f.content);
    if (on) st = st.update({ effects: setConflictMode.of({ on, swapped: summary(props.repoId)?.state === "rebasing" }) }).state;
    saved = st.doc;
    setConflicted(isConflicted);
    setConflicts(conflictCount(st));
    version = f.version;
    setDirty(false);
    setCursor({ line: 1, column: 1 });
    setLineEnd(lineEndLabel(f.content));
    if (view) view.setState(st);
    else setInitial(st);
    setPhase("text");
    view?.focus();
  };

  /** Reads the file and picks what to show: the text, the picture, or a note. `first` is false for a reload of text on screen. */
  const load = async (first: boolean): Promise<void> => {
    let f: TextFile;
    try {
      f = await api.readTextFile(props.repoId, props.path);
    } catch (e) {
      const message = toApiError(e).message;
      if (first) {
        setError(message);
        setPhase("error");
      } else {
        toast({ kind: "error", title: `Could not reload ${split.name}`, body: message, repoId: props.repoId });
      }
      return;
    }
    if (f.tooLarge || f.binary) {
      // the text editor goes away (a reload can find a file that became binary)
      view = undefined;
      saved = undefined;
      setInitial(null);
      setConflicts(0);
      setDirty(false);
      setPhase(isImagePath(props.path) ? "image" : f.tooLarge ? "tooLarge" : "binary");
    } else {
      // a failed status read only means the file is not treated as conflicted
      const wt = await api.workingTree(props.repoId).catch(() => null);
      showText(f, !!wt?.conflicted.some((c) => c.path === props.path));
    }
  };
  onMount(() => {
    box?.focus();
    void load(true);
  });
  onCleanup(() => previous?.focus?.());

  /**
   * Writes the text and closes. `overwrite` skips the version check (the user chose it after a changed-on-disk warning).
   * `stage` also stages the file (Mark as resolved); an unchanged file is then only staged.
   */
  const save = async (overwrite = false, stage = false): Promise<void> => {
    if (!view || phase() !== "text" || busy() || (!overwrite && !stage && !dirty())) return;
    const text = saveText(view.state);
    setBusy(true);
    try {
      if (overwrite || dirty()) version = await api.writeTextFile(props.repoId, props.path, text, overwrite ? null : version);
    } catch (e) {
      setBusy(false);
      const message = toApiError(e).message;
      if (!isStaleVersion(message)) {
        toast({ kind: "error", title: `Could not save ${split.name}`, body: message, repoId: props.repoId });
        return;
      }
      const choice = await openDialog(ChangedOnDisk, { name: split.name });
      if (choice === "overwrite") await save(true, stage);
      else if (choice === "reload") await load(false);
      else view?.focus();
      return;
    }
    if (stage) {
      const res = await actions.stage(props.repoId, [props.path]);
      if (res.ok.length === 0) {
        // the file is saved, but not staged: stay, so the user sees it is still open
        setBusy(false);
        saved = view.state.doc;
        setDirty(false);
        return;
      }
      toast({ kind: "success", title: `Resolved ${split.name}`, body: repo()?.name, repoId: props.repoId });
      props.close();
      await actions.offerContinue(props.repoId);
      return;
    }
    toast({ kind: "success", title: `Saved ${split.name}`, body: repo()?.name, repoId: props.repoId });
    props.close();
  };

  /** Saves the file and stages it. Refused (with a warning) while a conflict marker is left in the text. */
  const markResolved = (): void => {
    if (!view) return;
    const left = conflictCount(view.state);
    if (left > 0) {
      toast({ kind: "warning", title: `${plural(left, "conflict")} left in ${split.name}`, body: "Resolve every conflict before you mark the file as resolved." });
      goToConflict(view, 1);
      return;
    }
    void save(false, true);
  };

  /** Closes the dialog. Unsaved text asks first. */
  const requestClose = async (): Promise<void> => {
    if (closing || busy()) return;
    if (dirty()) {
      closing = true;
      const r = await confirmAction({
        title: "Discard your changes?",
        message: `${split.name} has changes that are not saved. If you close the editor, they are lost.`,
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        danger: true,
      });
      closing = false;
      if (!r) {
        view?.focus();
        return;
      }
    }
    props.close();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      // the find widget uses Esc to close itself; it marks the event as handled
      if (e.defaultPrevented) return;
      e.preventDefault();
      void requestClose();
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    } else if (e.key === "Tab" && box) {
      // Tab indents inside the editor (`indentWithTab`); outside it, the focus stays in the dialog.
      if ((e.target as Element | null)?.closest(".cm-editor")) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  /** Ctrl+F / Ctrl+H reach the editor even when the focus is on the header or the footer. */
  const onFindKey = (e: KeyboardEvent): void => {
    if (!view || phase() !== "text" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k !== "f" && k !== "h") return;
    if ((e.target as Element | null)?.closest(".cm-editor")) return;
    e.preventDefault();
    openFind(view, k === "h");
  };

  return (
    <div
      class="dg-scrim dg-qe-scrim"
      onKeyDown={(e) => {
        onKeyDown(e);
        onFindKey(e);
      }}
      onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}
    >
      <div ref={box} class="dg-qe-window" role="dialog" aria-modal="true" aria-label={`Edit ${props.path}`} tabindex={-1}>
        <header class="dg-qe-head">
          <Icon name={fileIconFor(props.path)} size={16} class="dg-qe-head-icon" />
          <h2 class="dg-qe-path" title={props.path}>
            <span class="dg-qe-dir">{split.dir}</span>
            <span class="dg-qe-name">{split.name}</span>
          </h2>
          <Show when={dirty()}>
            <span class="dg-qe-dirty" role="img" aria-label="Unsaved changes" title="Unsaved changes" />
          </Show>
          <Show when={projectRepos().length > 1 && repo()}>{(r) => <RepoChip name={r().name} />}</Show>
          <span class="dg-grow" />
          <span class="dg-qe-lang">{phase() === "text" ? languageLabel(props.path) : "Quick editor"}</span>
          <IconButton icon="close" label="Close" onClick={() => void requestClose()} />
        </header>

        <div class="dg-qe-body">
          <Show when={phase() === "text" && (conflicted() || conflicts() > 0)}>
            <div class="dg-qe-cfbar" classList={{ "is-resolved": conflicts() === 0 }} role="status">
              <Icon name={conflicts() === 0 ? "check" : "conflict"} size={16} class="dg-qe-cfbar-icon" />
              <span class="dg-qe-cfbar-text">
                {conflicts() > 0 ? `${plural(conflicts(), "conflict")} left in this file` : conflicted() ? "No conflict markers left. Mark the file as resolved." : "No conflict markers left."}
              </span>
              <Show when={conflicts() > 0}>
                <IconButton icon="chevronUp" label="Previous conflict" shortcut="Shift+F7" size="small" onClick={() => view && goToConflict(view, -1)} />
                <IconButton icon="chevronDown" label="Next conflict" shortcut="F7" size="small" onClick={() => view && goToConflict(view, 1)} />
              </Show>
              <span class="dg-grow" />
              <Show when={conflicted()}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={dirty() || busy()}
                  title={dirty() ? "Save the file first" : "Open the three-pane merge window for this file"}
                  onClick={() => {
                    props.close();
                    void actions.openMerge(props.repoId, props.path);
                  }}
                >
                  Merge window…
                </Button>
                <Button
                  size="small"
                  variant="primary"
                  disabled={busy()}
                  title={conflicts() > 0 ? "Resolve every conflict first" : "Save the file and stage it"}
                  onClick={markResolved}
                >
                  Mark as resolved
                </Button>
              </Show>
            </div>
          </Show>
          <Switch>
            <Match when={phase() === "loading"}>
              <div class="dg-qe-state">
                <Spinner />
                <p>Loading {split.name}…</p>
              </div>
            </Match>
            <Match when={phase() === "error"}>
              <div class="dg-qe-state" role="alert">
                <Icon name="error" size={20} />
                <p class="dg-selectable">{error()}</p>
                <Button
                  onClick={() => {
                    setPhase("loading");
                    void load(true);
                  }}
                >
                  Retry
                </Button>
              </div>
            </Match>
            <Match when={phase() === "binary"}>
              <EmptyState icon="fileBinary" title="Binary file — cannot be edited here">
                DeepGit edits text files only. Open this one in a program that supports it.
              </EmptyState>
            </Match>
            <Match when={phase() === "tooLarge"}>
              <EmptyState icon="fileBinary" title="File too large to edit here">
                The quick editor opens files up to 2 MiB. Use a code editor for this one.
              </EmptyState>
            </Match>
            <Match when={phase() === "image"}>
              <ImagePreview repoId={props.repoId} path={props.path} />
            </Match>
            <Match when={phase() === "text" && initial()}>
              {(st) => <TextSurface state={st()} onView={(v) => (view = v)} />}
            </Match>
          </Switch>
        </div>

        <footer class="dg-qe-foot">
          <span class="dg-qe-meta">
            <Show when={phase() === "text"}>
              <span>
                Ln {cursor().line}, Col {cursor().column}
              </span>
              <span>{lineEnd()}</span>
              <span>UTF-8</span>
            </Show>
          </span>
          <Button onClick={() => void requestClose()}>{phase() === "text" ? "Cancel" : "Close"}</Button>
          <Show when={phase() === "text"}>
            <Button variant="primary" disabled={!dirty() || busy()} shortcut="Ctrl+S" onClick={() => void save()}>
              Save
            </Button>
          </Show>
        </footer>
      </div>
    </div>
  );
}
