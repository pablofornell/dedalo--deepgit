import { describe, expect, it } from "vitest";
import { APP_VERSION, BUILD_DATE, formatBuildDate, formatVersionInfo, platformName } from "./aboutInfo";

describe("build constants", () => {
  it("have a fallback when the build does not inject them", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof BUILD_DATE).toBe("string");
  });
});

describe("formatBuildDate", () => {
  it("uses the absolute date format", () => {
    expect(formatBuildDate("2026-11-10T14:32:05.000Z")).toMatch(/^\d{2}-\d{2}-2026 \d{2}:\d{2}$/);
  });
  it("says Unknown for an empty or invalid value", () => {
    expect(formatBuildDate("")).toBe("Unknown");
    expect(formatBuildDate("not a date")).toBe("Unknown");
  });
});

describe("platformName", () => {
  it("reads the system from the user agent", () => {
    expect(platformName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("Windows");
    expect(platformName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macOS");
    expect(platformName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("Linux");
    expect(platformName("curl/8")).toBe("Unknown");
  });
});

describe("formatVersionInfo", () => {
  it("lists version, build date, runtime and platform", () => {
    const text = formatVersionInfo({ version: "0.3.0", buildDate: "", tauri: "2.1.0", platform: "Linux" });
    expect(text).toBe("DeepGit 0.3.0\nBuilt: Unknown\nTauri: 2.1.0\nPlatform: Linux");
  });
  it("leaves the Tauri line out when the runtime is not known", () => {
    const text = formatVersionInfo({ version: "0.3.0", buildDate: "", tauri: null, platform: "Linux" });
    expect(text).not.toContain("Tauri");
  });
});
