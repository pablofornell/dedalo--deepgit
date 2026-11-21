/**
 * The "Add to" list of the ignore dialogs: the file that gets the lines (`.gitignore`, `.git/info/exclude` or the global ignore
 * file), who the rule applies to, and the path of the file. Both lines are always there, so the dialog does not change size
 * when the choice or the path changes.
 */
import { type JSX } from "solid-js";
import type { IgnoreTarget } from "../../api/types";
import { Select } from "../../components/ui";
import { Field } from "./parts";
import { TARGET_LABEL, TARGET_SCOPE } from "./ignoreRules";

const OPTIONS = (["gitignore", "exclude", "global"] as const).map((value) => ({ value, label: TARGET_LABEL[value] }));

export function IgnoreTargetField(props: {
  value: IgnoreTarget;
  onChange: (t: IgnoreTarget) => void;
  /** The path of the file of `value`. Null while it is being read. */
  path: string | null;
}): JSX.Element {
  return (
    <Field label="Add to">
      <Select class="dg-dialogs-select" ariaLabel="Add to" value={props.value} onChange={props.onChange} options={OPTIONS} />
      <span class="dg-dialogs-hint">{TARGET_SCOPE[props.value]}</span>
      <span class="dg-dialogs-hint dg-dialogs-target-path dg-selectable" title={props.path ?? undefined}>
        {props.path ?? " "}
      </span>
    </Field>
  );
}
