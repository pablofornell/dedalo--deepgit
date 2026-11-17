/**
 * CodeMirror 6 state of the file in the quick editor. It does not use Solid.
 *
 * The module uses `@codemirror/state`, `@codemirror/view`, `@codemirror/commands` and `@codemirror/search`.
 * The find and replace widget is in `find/panel.tsx`. The conflict resolver (colours and actions for the hunks of a
 * conflicted file) is in `conflictEditor.ts`.
 * The syntax colours come from `features/merge/editor.ts` (`syntaxPlugin`) and `features/diff/syntax.ts`.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { languageFor } from "../diff/syntax";
import { syntaxPlugin } from "../merge/editor";
import { conflictExtension } from "./conflictEditor";
import { findExtension, findKeymap } from "./find/panel";
import { crlfInput } from "./lineEnds";
import { lineSeparatorOf } from "./model";

/** Creates the state for the text `doc` of the file `path`. `onUpdate` runs after each transaction of this state. */
export function createFileState(doc: string, path: string, onUpdate: (u: ViewUpdate) => void): EditorState {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    findExtension(),
    highlightSelectionMatches(),
    keymap.of([...findKeymap, ...searchKeymap.filter((k) => !["Mod-f", "F3", "Mod-g", "Escape"].includes(k.key ?? "")), ...defaultKeymap, ...historyKeymap, indentWithTab]),
    syntaxPlugin(languageFor(path)),
    conflictExtension(),
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
    EditorView.updateListener.of(onUpdate),
  ];
  // The CRLF facet keeps the line breaks of the file. `sliceDoc()` then writes them back as they were.
  // The filter turns LF text (a paste) into CRLF, so that it splits into lines and saves with CRLF.
  if (lineSeparatorOf(doc) === "\r\n") extensions.push(EditorState.lineSeparator.of("\r\n"), crlfInput);
  return EditorState.create({ doc, extensions });
}

/** Returns the text to write to disk. It is the whole document, with its line separators. */
export function saveText(state: EditorState): string {
  return state.sliceDoc();
}
