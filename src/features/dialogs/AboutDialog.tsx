/** About DeepGit: logo, name, version, build date, runtime, licence, links, and a button that copies the version info for a bug report. */
import { type JSX, For, Show, createSignal, onMount } from "solid-js";
import { AppLogo } from "../../components/ui/AppLogo";
import { Button, Dialog, type DialogComponentProps, toast, copyText } from "../../components/ui";
import type { AboutProps } from "../../state/dialogs";
import {
  APP_NAME, APP_VERSION, BUILD_DATE, ISSUES_URL, LICENSE_NAME, RELEASES_URL, REPO_URL,
  formatBuildDate, formatVersionInfo, inDesktopApp, openExternal, platformName, readTauriVersion,
} from "./aboutInfo";
import "./dialogs.css";

const LINKS: { label: string; url: string }[] = [
  { label: "GitHub repository", url: REPO_URL },
  { label: "Releases", url: RELEASES_URL },
  { label: "Report an issue", url: ISSUES_URL },
];

export function AboutDialog(props: AboutProps & DialogComponentProps<void>): JSX.Element {
  const [tauri, setTauri] = createSignal<string | null>(null);
  onMount(() => void readTauriVersion().then(setTauri));

  const platform = typeof navigator !== "undefined" ? platformName(navigator.userAgent) : "Unknown";
  const rows = (): [string, string][] => {
    const out: [string, string][] = [
      ["Version", APP_VERSION],
      ["Built", formatBuildDate(BUILD_DATE)],
    ];
    if (tauri()) out.push(["Tauri", tauri()!]);
    out.push(["Platform", platform], ["Licence", LICENSE_NAME]);
    return out;
  };

  const copy = async (): Promise<void> => {
    const ok = await copyText(formatVersionInfo({ version: APP_VERSION, buildDate: BUILD_DATE, tauri: tauri(), platform }));
    toast(ok ? { kind: "success", title: "Version info copied" } : { kind: "error", title: "Could not copy the version info" });
  };

  return (
    <Dialog
      title={`About ${APP_NAME}`}
      onClose={() => props.close()}
      cancelLabel="Close"
      footerLeft={<Button onClick={() => void copy()}>Copy version info</Button>}
    >
      <div class="dg-dialogs-about-head">
        <AppLogo size={56} />
        <div class="dg-dialogs-about-name">
          <span class="dg-dialogs-about-title">{APP_NAME}</span>
          <span class="dg-dialogs-hint">A Git client for projects with many repositories.</span>
        </div>
      </div>
      <dl class="dg-dialogs-about-facts">
        <For each={rows()}>
          {([k, v]) => (
            <>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </>
          )}
        </For>
      </dl>
      <div class="dg-dialogs-links">
        <For each={LINKS}>
          {(l) => (
            <Show when={inDesktopApp} fallback={<span class="dg-dialogs-hint" title={l.url}>{l.label}: {l.url}</span>}>
              <a class="dg-dialogs-link" href={l.url} title={l.url} onClick={(e) => { e.preventDefault(); void openExternal(l.url); }}>
                {l.label}
              </a>
            </Show>
          )}
        </For>
      </div>
    </Dialog>
  );
}
