/**
 * Gitignore templates: the usual rules of a language, a build tool, an editor or an operating system, picked by checkbox and
 * added to `.gitignore`, `.git/info/exclude` or the global ignore file. "Detect" scans the repository when the user clicks it
 * and checks the templates it calls for. A template whose block is in the file already shows as added. The dialog writes the
 * blocks (`api.appendIgnoreBlocks`) and shows the toast. It does not stage or commit.
 */
import { type JSX, For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js";
import { textLines, tidyBlock } from "../../api/ignoreBlocks";
import * as api from "../../api/tauri";
import type { IgnoreTarget } from "../../api/types";
import { Badge, Button, Checkbox, Dialog, type DialogComponentProps, Spinner, plural, toast } from "../../components/ui";
import type { IgnoreTemplatesProps, IgnoreTemplatesResult } from "../../state/dialogs";
import { editFile } from "../../state/actions";
import { repoById } from "../../state/workspace";
import {
  TEMPLATES, TEMPLATE_GROUPS, TEMPLATE_ORDER, addLabel, addedTemplatesTitle, detectTemplates, patternCount, planTemplates, presentIds, templateNameOfHeader,
  templatesOf,
  type Detection, type Template,
} from "../../state/gitignoreTemplates";
import { IgnoreTargetField } from "./IgnoreTargetField";
import { Note } from "./parts";
import { addedBody, targetName } from "./ignoreRules";

type Scan = { state: "idle" } | { state: "busy" } | { state: "done"; found: Detection } | { state: "error"; message: string };

const message = (e: unknown): string => (e as { message?: string })?.message ?? String(e);

/** The class of a preview line. */
const lineClass = (l: string): string => (l.startsWith("# --- DeepGit template:") ? "is-header" : l.startsWith("#") ? "is-comment" : "");

export function IgnoreTemplatesDialog(props: IgnoreTemplatesProps & DialogComponentProps<IgnoreTemplatesResult>): JSX.Element {
  const repoName = repoById(props.repoId)?.name ?? props.repoId;
  const [target, setTarget] = createSignal<IgnoreTarget>(props.target ?? "gitignore");
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const [scan, setScan] = createSignal<Scan>({ state: "idle" });
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  // ---- the target file: its text tells which templates it holds
  const [existing] = createResource(target, (t) => api.readIgnoreFile(props.repoId, t));
  const text = (): string | null => (existing.state === "ready" ? (existing()?.content ?? "") : null);
  /** False for a file that is not UTF-8: a template only goes to its end. */
  const canInsert = (): boolean => (existing.state === "ready" ? (existing()?.canInsert ?? true) : true);
  const filePath = (): string | null => (existing.state === "ready" ? (existing()?.path ?? null) : null);
  const readError = (): string | null => (existing.state === "errored" ? message(existing.error) : null);
  const targetLabel = (): string => (target() === "gitignore" ? `${repoName}/.gitignore` : target() === "exclude" ? ".git/info/exclude" : (filePath() ?? targetName("global")));

  /** The templates whose block the file holds. */
  const present = createMemo<ReadonlySet<string>>(() => presentIds(text() ?? ""));
  /** The templates that add nothing: the file holds every pattern already (written by hand, without the header). */
  const covered = createMemo<ReadonlySet<string>>(() => {
    const t = text();
    if (t === null) return new Set();
    const lines = new Set(textLines(t));
    return new Set(TEMPLATES.filter((x) => !present().has(x.id) && tidyBlock(x.lines, new Set(lines)).length === 0).map((x) => x.id));
  });
  const off = (id: string): boolean => present().has(id) || covered().has(id);
  const checked = (id: string): boolean => picked().has(id) && !off(id);
  const effective = createMemo<ReadonlySet<string>>(() => new Set(TEMPLATES.filter((t) => checked(t.id)).map((t) => t.id)));

  const plan = createMemo(() => (text() === null ? { entries: [], blocks: [], groups: [], preview: [], warnings: [] } : planTemplates(text() ?? "", effective(), canInsert())));
  /** The repo sets its own `core.excludesFile`: git does not read the global file here. */
  const localOverride = (): string | null => (target() === "global" && existing.state === "ready" ? (existing()?.localExcludesFile ?? null) : null);
  const allAtEnd = () => plan().groups.every((g) => g.before === null);
  const addedRules = () => plan().entries.reduce((n, e) => n + e.added, 0);
  const canSubmit = () => !busy() && text() !== null && plan().blocks.length > 0;

  const toggle = (id: string, on: boolean): void => {
    const next = new Set(picked());
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  // ---- the scan, on request
  let run = 0;
  const detect = async (): Promise<void> => {
    const me = ++run;
    setScan({ state: "busy" });
    try {
      const found = detectTemplates(await api.listFiles(props.repoId));
      if (me !== run) return;
      setScan({ state: "done", found });
      const next = new Set(picked());
      for (const id of found.ids) if (!off(id)) next.add(id);
      setPicked(next);
    } catch (e) {
      if (me === run) setScan({ state: "error", message: message(e) });
    }
  };
  const detected = (id: string): boolean => {
    const s = scan();
    return s.state === "done" && s.found.ids.includes(id);
  };
  const reason = (id: string): string | undefined => {
    const s = scan();
    return s.state === "done" ? s.found.reasons[id] : undefined;
  };
  const status = (): string => {
    const s = scan();
    if (s.state === "busy") return "Scanning the files…";
    if (s.state === "error") return "The scan failed.";
    if (s.state === "done") return s.found.ids.length === 0 ? "Nothing found. Pick templates by hand." : `Found ${plural(s.found.ids.length, "template")}.`;
    return "Find the templates this repository needs.";
  };

  const incomplete = (): boolean => {
    const s = scan();
    return s.state === "done" && s.found.incomplete;
  };
  const scanError = (): string | null => {
    const s = scan();
    return s.state === "error" ? s.message : null;
  };

  // ---- notes
  /** Language and build rules are wide (`*.jar`, `build/`, `.env`): in the global file they hide files in every repository. */
  const wideInGlobal = (): boolean =>
    target() === "global" && plan().entries.some((e) => e.state === "new" && ["languages", "build"].includes(TEMPLATES.find((t) => t.id === e.id)?.group ?? ""));
  createEffect(() => {
    target();
    setFailure(null);
  });

  const submit = async (): Promise<void> => {
    if (!canSubmit()) return;
    setBusy(true);
    setFailure(null);
    const t = target();
    try {
      const added = await api.appendIgnoreBlocks(props.repoId, t, plan().blocks, TEMPLATE_ORDER);
      const name = targetName(t);
      if (added.length === 0) {
        toast({ kind: "info", title: `Nothing new for ${name}`, body: `${targetLabel()} has these templates already.` });
      } else {
        toast({
          kind: "success",
          title: addedTemplatesTitle(added, name),
          body: addedBody(t, repoName, targetLabel()),
          actions: t === "gitignore" ? [{ label: "Open .gitignore", onClick: () => void editFile(props.repoId, ".gitignore") }] : undefined,
        });
      }
      props.close({ target: t, added });
    } catch (e) {
      setFailure(message(e));
      setBusy(false);
    }
  };

  const Row = (p: { t: Template }): JSX.Element => (
    <div class="dg-dialogs-tpl-item" classList={{ "is-on": checked(p.t.id), "is-off": off(p.t.id) }}>
      <Checkbox
        checked={checked(p.t.id)}
        disabled={off(p.t.id)}
        onChange={(on) => toggle(p.t.id, on)}
        title={present().has(p.t.id) ? "This file has this template already." : covered().has(p.t.id) ? "This file has every rule of this template already." : undefined}
        label={
          <span class="dg-dialogs-tpl-text">
            <span class="dg-dialogs-tpl-head">
              <span class="dg-dialogs-tpl-name">{p.t.name}</span>
              <Show when={present().has(p.t.id)}>
                <Badge tone="success">Added</Badge>
              </Show>
              <Show when={!present().has(p.t.id) && covered().has(p.t.id)}>
                <Badge title="Every rule of this template is in the file already.">Covered</Badge>
              </Show>
              <Show when={!off(p.t.id) && detected(p.t.id)}>
                <Badge tone="accent" title={reason(p.t.id) ? `Found ${reason(p.t.id)}` : undefined}>Detected</Badge>
              </Show>
              <span class="dg-dialogs-tpl-count">{patternCount(p.t)} rules</span>
            </span>
            <span class="dg-dialogs-tpl-desc">{p.t.summary}</span>
          </span>
        }
      />
    </div>
  );

  return (
    <Dialog
      title="Gitignore templates"
      width="large"
      onClose={() => props.close()}
      primary={{ label: addLabel(plan()), disabled: !canSubmit(), onClick: () => void submit() }}
      footerLeft={
        <Button variant="ghost" icon="close" disabled={picked().size === 0 || busy()} onClick={() => setPicked(new Set())}>
          Clear selection
        </Button>
      }
    >
      <div class="dg-dialogs-tpl">
        <div class="dg-dialogs-tpl-col">
          <div class="dg-dialogs-tpl-bar">
            <Button icon="search" disabled={scan().state === "busy"} onClick={() => void detect()} title="Look at the files of this repository and check the templates it needs">
              Detect
            </Button>
            <span class="dg-dialogs-tpl-status" role="status" aria-live="polite">
              <Show when={scan().state === "busy"}>
                <Spinner size={14} />
              </Show>
              {status()}
            </span>
          </div>
          <div class="dg-dialogs-tpl-list" role="group" aria-label="Templates">
            <For each={TEMPLATE_GROUPS}>
              {(g) => (
                <div class="dg-dialogs-tpl-group" role="group" aria-label={g.label}>
                  <span class="dg-dialogs-tpl-group-title">{g.label}</span>
                  <For each={templatesOf(g.id)}>{(t) => <Row t={t} />}</For>
                </div>
              )}
            </For>
          </div>
          <Show when={incomplete()}>
            <Note kind="info">The repository has too many files to list them all, so the scan may have missed a template.</Note>
          </Show>
          <Show when={scanError()}>{(m) => <Note kind="error">{m()}</Note>}</Show>
        </div>
        <div class="dg-dialogs-tpl-col">
          <IgnoreTargetField value={target()} onChange={setTarget} path={filePath()} />
          <Show when={wideInGlobal()}>
            <Note kind="warning">
              A global rule hides files in every repository, also in projects that track them (like *.jar, build/ or .env). Operating system and editor templates fit best.
            </Note>
          </Show>
          <Show when={localOverride()}>
            {(f) => (
              <Note kind="warning">
                This repository sets its own core.excludesFile ({f()}), so git does not read the global file here. The rules still apply to the other repositories.
              </Note>
            )}
          </Show>
          <For each={plan().warnings}>{(w) => <Note kind="warning">{w}</Note>}</For>
          <Show when={readError()}>{(n) => <Note kind="error">{n()}</Note>}</Show>
          <Show when={failure()}>{(n) => <Note kind="error">{n()}</Note>}</Show>
          <div class="dg-dialogs-tpl-preview-head">
            <span class="dg-dialogs-label">{allAtEnd() ? `Added at the end of ${targetLabel()}` : `Added to ${targetLabel()}`}</span>
            <span class="dg-dialogs-tpl-preview-count">
              {plan().blocks.length > 0 ? `${plural(plan().blocks.length, "template")}, ${plural(addedRules(), "rule")}` : ""}
            </span>
          </div>
          <div class="dg-dialogs-tpl-preview dg-selectable" aria-label="Lines to add" tabindex="0">
            <For each={plan().groups}>
              {(g) => (
                <>
                  <Show when={!allAtEnd()}>
                    <span class="dg-dialogs-tpl-line is-place">{g.before === null ? "At the end of the file" : `Before the ${templateNameOfHeader(g.before)} block`}</span>
                  </Show>
                  <For each={g.lines}>{(l) => <span class={`dg-dialogs-tpl-line ${lineClass(l)}`}>{l}</span>}</For>
                </>
              )}
            </For>
            <Show when={plan().preview.length === 0}>
              <div class="dg-dialogs-tpl-empty">
                {picked().size === 0 ? "Check templates on the left, or click Detect. The lines appear here." : "Nothing to add: the file has what you checked already."}
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
