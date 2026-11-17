/**
 * Pure helpers of the quick editor. They do not use the DOM or Solid.
 * They cover the line separator, the changed-on-disk message and the language label in the header.
 */
import { languageFor, type Lang } from "../diff/syntax";

/** The start of the message that the backend sends when a save finds the file changed on disk. */
export const CHANGED_ON_DISK = "The file changed on disk.";

/** Returns "\r\n" when the content has a CRLF line break. Otherwise it returns "\n". The editor keeps this separator on save. */
export function lineSeparatorOf(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Returns true when a save failed because the file changed on disk. */
export function isStaleVersion(message: string): boolean {
  return message.startsWith(CHANGED_ON_DISK);
}

const LANGUAGE_NAMES: Record<Lang, string> = {
  rust: "Rust",
  ts: "TypeScript / JavaScript",
  json: "JSON",
  toml: "TOML",
  yaml: "YAML",
  md: "Markdown",
  css: "CSS",
  sql: "SQL",
  py: "Python",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  sh: "Shell",
};

/** Returns the name of the language that the syntax colours use for `path`, or "Plain text" when there is none. */
export function languageLabel(path: string): string {
  const lang = languageFor(path);
  return lang ? LANGUAGE_NAMES[lang] : "Plain text";
}

/** Returns the label of the line separator of `content`, as the footer shows it. */
export function lineEndLabel(content: string): "CRLF" | "LF" {
  return lineSeparatorOf(content) === "\r\n" ? "CRLF" : "LF";
}
