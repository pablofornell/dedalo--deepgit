/** Stash: message, include untracked, keep index; shows what each repo would stash. */
import { type JSX, Show, createSignal } from "solid-js";
import { Checkbox, Dialog, type DialogComponentProps, TextField, plural } from "../../components/ui";
import type { StashProps, StashResult } from "../../state/dialogs";
import { summary } from "../../state/workspace";
import { Field, Note, RepoRows } from "./parts";

export function StashDialog(props: StashProps & DialogComponentProps<StashResult>): JSX.Element {
  const [message, setMessage] = createSignal("");
  const [includeUntracked, setIncludeUntracked] = createSignal(false);
  const [keepIndex, setKeepIndex] = createSignal(false);

  const counts = (id: string) => {
    const s = summary(id);
    return s ? { staged: s.staged, unstaged: s.unstaged, untracked: s.untracked } : null;
  };
  const stashable = (id: string): number | null => {
    if (props.files) return props.files[id]?.count ?? 0;
    const c = counts(id);
    return c ? c.staged + c.unstaged + (includeUntracked() ? c.untracked : 0) : null;
  };
  const known = () => props.repoIds.every((id) => stashable(id) !== null);
  const nothing = () => known() && props.repoIds.every((id) => stashable(id) === 0);

  const detail = (id: string): string => {
    if (props.files) return plural(props.files[id]?.count ?? 0, "file");
    const c = counts(id);
    if (!c) return "";
    const parts = [c.staged > 0 && `${c.staged} staged`, c.unstaged > 0 && `${c.unstaged} unstaged`, c.untracked > 0 && `${c.untracked} untracked`].filter((x): x is string => !!x);
    return parts.length > 0 ? parts.join(", ") : "no changes";
  };

  return (
    <Dialog
      title="Stash changes"
      onClose={() => props.close()}
      primary={{
        label: "Stash",
        disabled: nothing(),
        onClick: () => props.close({ message: message().trim() || null, includeUntracked: includeUntracked(), keepIndex: keepIndex() }),
      }}
    >
      <Field label="Message (optional)">
        <TextField value={message()} onInput={setMessage} placeholder="WIP: refund validation" aria-label="Stash message" />
      </Field>
      <RepoRows rows={props.repoIds.map((id) => ({ repoId: id, detail: detail(id) }))} />
      <div class="dg-dialogs-options">
        <Show when={!props.files}>
          <Checkbox checked={includeUntracked()} onChange={setIncludeUntracked} label="Include untracked files" />
        </Show>
        <Checkbox checked={keepIndex()} onChange={setKeepIndex} label="Keep index (leave staged changes staged)" />
      </div>
      <Show when={props.files}>
        <Note kind="info">Only the selected files are stashed, with all of their changes (staged and unstaged). Untracked files in the selection are included.</Note>
      </Show>
      <Show when={nothing()}>
        <Note kind="info">There is nothing to stash.{includeUntracked() ? "" : " Untracked files are only stashed when you include them."}</Note>
      </Show>
    </Dialog>
  );
}
