/** Facts and pure helpers of the About dialog: build constants with a fallback, the links, the text of "Copy version info". */
import { formatAbsolute } from "../../state/dateFormat";

export const APP_NAME = "DeepGit";
export const LICENSE_NAME = "MIT License";
export const REPO_URL = "https://github.com/pablofornell/prometeo--deepgit";
export const RELEASES_URL = `${REPO_URL}/releases`;
export const ISSUES_URL = `${REPO_URL}/issues`;

/** Injected by `vite.config.ts`. Not defined in vitest, so the fallback keeps the tests (and any other tool) working. */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
export const BUILD_DATE: string = typeof __BUILD_DATE__ === "string" ? __BUILD_DATE__ : "";

export interface AboutInfo {
  version: string;
  /** ISO 8601 string, or "" when unknown. */
  buildDate: string;
  /** Version of the Tauri runtime; null outside the desktop app. */
  tauri: string | null;
  /** Operating system, from the user agent. */
  platform: string;
}

/** The build date in the app's absolute date format ("10-11-2026 14:32"), or "Unknown" when it is empty or not a date. */
export function formatBuildDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "Unknown" : formatAbsolute(Math.floor(ms / 1000));
}

/** Operating system name from a user agent string. */
export function platformName(userAgent: string): string {
  if (/windows/i.test(userAgent)) return "Windows";
  if (/mac os x|macintosh/i.test(userAgent)) return "macOS";
  if (/linux|x11/i.test(userAgent)) return "Linux";
  return "Unknown";
}

/** Plain text for bug reports. */
export function formatVersionInfo(info: AboutInfo): string {
  const lines = [`${APP_NAME} ${info.version}`, `Built: ${formatBuildDate(info.buildDate)}`];
  if (info.tauri) lines.push(`Tauri: ${info.tauri}`);
  lines.push(`Platform: ${info.platform}`);
  return lines.join("\n");
}

/** True when running inside the Tauri shell: links open and the runtime version is known only then. */
export const inDesktopApp: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Opens a URL with the system browser (opener plugin, desktop app only). */
export async function openExternal(url: string): Promise<void> {
  if (!inDesktopApp) return;
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** Version of the Tauri runtime, or null when it cannot be read. */
export async function readTauriVersion(): Promise<string | null> {
  if (!inDesktopApp) return null;
  try {
    const { getTauriVersion } = await import("@tauri-apps/api/app");
    return await getTauriVersion();
  } catch {
    return null;
  }
}
