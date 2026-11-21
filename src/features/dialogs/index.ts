/**
 * Registers the dialog components (see `state/dialogs.ts`). Called once at startup from `App`.
 * One file per dialog; the generic "confirm" lives in `components/ui` and registers itself.
 */
import { lazy } from "solid-js";
import { registerDialog } from "../../state/dialogs";
import { AboutDialog } from "./AboutDialog";
import { AuthDialog } from "./AuthDialog";
import { CheckoutRemoteDialog } from "./CheckoutRemoteDialog";
import { CloneDialog } from "./CloneDialog";
import { IgnoreDialog } from "./IgnoreDialog";
import { IgnoreTemplatesDialog } from "./IgnoreTemplatesDialog";
import { InitRepositoryDialog } from "./InitRepositoryDialog";
import { MergeDialog } from "./MergeDialog";
import { NewBranchDialog } from "./NewBranchDialog";
import { PushDialog } from "./PushDialog";
import { RebaseDialog } from "./RebaseDialog";
import { RenameBranchDialog } from "./RenameBranchDialog";
import { RenameProjectDialog } from "./RenameProjectDialog";
import { ResetDialog } from "./ResetDialog";
import { StashDialog } from "./StashDialog";
import { TagDialog } from "./TagDialog";

/** The quick editor (CodeMirror) is loaded the first time a file is edited. */
const QuickEditDialog = lazy(() => import("../quickedit/QuickEditDialog").then((m) => ({ default: m.QuickEditDialog })));

export function registerAllDialogs(): void {
  registerDialog("newBranch", NewBranchDialog);
  registerDialog("renameBranch", RenameBranchDialog);
  registerDialog("merge", MergeDialog);
  registerDialog("rebase", RebaseDialog);
  registerDialog("reset", ResetDialog);
  registerDialog("push", PushDialog);
  registerDialog("stash", StashDialog);
  registerDialog("tag", TagDialog);
  registerDialog("checkoutRemote", CheckoutRemoteDialog);
  registerDialog("clone", CloneDialog);
  registerDialog("auth", AuthDialog);
  registerDialog("renameProject", RenameProjectDialog);
  registerDialog("ignore", IgnoreDialog);
  registerDialog("ignoreTemplates", IgnoreTemplatesDialog);
  registerDialog("initRepository", InitRepositoryDialog);
  registerDialog("quickEdit", QuickEditDialog);
  registerDialog("about", AboutDialog);
}
