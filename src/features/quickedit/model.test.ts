import { describe, expect, it } from "vitest";
import { isStaleVersion, languageLabel, lineEndLabel, lineSeparatorOf } from "./model";

describe("lineSeparatorOf", () => {
  it("is CRLF only when the content has a CRLF", () => {
    expect(lineSeparatorOf("a\r\nb")).toBe("\r\n");
    expect(lineSeparatorOf("a\nb")).toBe("\n");
    expect(lineSeparatorOf("a\rb")).toBe("\n");
    expect(lineSeparatorOf("")).toBe("\n");
  });

  it("names the separator for the footer", () => {
    expect(lineEndLabel("a\r\nb")).toBe("CRLF");
    expect(lineEndLabel("a\nb")).toBe("LF");
  });
});

describe("isStaleVersion", () => {
  it("recognises the changed-on-disk message", () => {
    expect(isStaleVersion("The file changed on disk. Reload it before you save.")).toBe(true);
    expect(isStaleVersion("Permission denied")).toBe(false);
  });
});

describe("languageLabel", () => {
  it("names the language of the syntax colours", () => {
    expect(languageLabel("README.md")).toBe("Markdown");
    expect(languageLabel("config/site.toml")).toBe("TOML");
    expect(languageLabel("src/app.tsx")).toBe("TypeScript / JavaScript");
    expect(languageLabel("Dockerfile")).toBe("Shell");
  });

  it("falls back to plain text", () => {
    expect(languageLabel(".gitignore")).toBe("Plain text");
    expect(languageLabel("notes.txt")).toBe("Plain text");
  });
});
