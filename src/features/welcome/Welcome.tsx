/**
 * First screen when the workspace has no project (DESIGN.md 9.2, 9.3): logo, title, one line of intro,
 * the "Add project folder…" action, three feature cards and the keyboard hints. `App` shows it instead of
 * the shell.
 */
import { For, type JSX, Show, createSignal } from "solid-js";
import { pickFolder } from "../../api/dialog";
import { AppLogo, Button, Icon, type IconName, Kbd, Spinner, WindowControls, dragRegion } from "../../components/ui";
import { cloneRepository } from "../../state/actions";
import { addProject } from "../../state/workspace";
import "./welcome.css";

interface Feature {
  icon: IconName;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  { icon: "repo", title: "Multi-repo projects", body: "Add one folder and DeepGit finds every repository in it, nested ones included." },
  { icon: "log", title: "Commit graph", body: "Commits from every repository in one graph, each branch in its own colour." },
  { icon: "console", title: "Every git command is visible", body: "The Git console lists each command DeepGit runs, with its output and exit code." },
];

/** Text of a rejection. `ApiError` carries a `message`; anything else is stringified. */
function messageOf(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") return e.message;
  return String(e);
}

export function Welcome(): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  /** Picks a folder and adds it as a project. Cancelling the picker does nothing. On success the shell replaces this screen. */
  async function addFolder(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const path = await pickFolder("Add project folder");
      if (path) await addProject(path);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="dg-welcome">
      <div class="dg-welcome-bar" {...dragRegion}>
        <WindowControls />
      </div>

      <main class="dg-welcome-main">
        <div class="dg-welcome-inner">
          <div class="dg-welcome-hero">
            <AppLogo size={48} small />
            <h1 class="dg-welcome-title">DeepGit</h1>
            <p class="dg-welcome-tagline">Git for projects that span many repositories.</p>
          </div>

          <div class="dg-welcome-action">
            <Button variant="primary" disabled={busy()} onClick={() => void addFolder()}>
              <Show when={busy()}>
                <Spinner size={14} />
              </Show>
              Add project folder…
            </Button>
            <button type="button" class="dg-welcome-link" disabled={busy()} onClick={() => void cloneRepository()}>
              Clone repository…
            </button>
            <Show when={error()}>
              {(msg) => (
                <p class="dg-welcome-error" role="alert">
                  {msg()}
                </p>
              )}
            </Show>
          </div>

          <ul class="dg-welcome-cards">
            <For each={FEATURES}>
              {(f) => (
                <li class="dg-welcome-card">
                  <Icon name={f.icon} size={20} class="dg-welcome-card-icon" />
                  <h2 class="dg-welcome-card-title">{f.title}</h2>
                  <p class="dg-welcome-card-body">{f.body}</p>
                </li>
              )}
            </For>
          </ul>

          <p class="dg-welcome-keys">
            <span>
              <Kbd keys="Shift Shift" /> Search everywhere
            </span>
            <span>
              <Kbd keys="Ctrl+K" /> Commands
            </span>
          </p>
        </div>
      </main>
    </div>
  );
}
