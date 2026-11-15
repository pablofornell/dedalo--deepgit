/**
 * Text of the filter field above the project tree (sidebar). Session state: it is not saved, and the sidebar clears it
 * when another project opens. `Ctrl+Alt+F` (`state/shortcuts.ts`) asks the field to take the focus.
 *
 *   setProjectFilter("api");            // the tree shows the repos whose name has "api"
 *   requestProjectFilterFocus();        // the field focuses itself as soon as it exists
 */
import { createSignal } from "solid-js";

const [projectFilter, setProjectFilter] = createSignal("");
const [focusRequested, setFocusRequested] = createSignal(false);

export { projectFilter, setProjectFilter };

/** True from `requestProjectFilterFocus()` until the field has taken the focus. */
export const projectFilterFocusRequested = focusRequested;

export const requestProjectFilterFocus = () => setFocusRequested(true);
export const consumeProjectFilterFocus = () => setFocusRequested(false);
