import { describe, expect, it } from "vitest";
import {
  MAX_COUNTED_FILES, TARGET_LABEL, TARGET_SCOPE, addedBody, addedTitle, countMatches, defaultKind, escapeSegment, extensionOf, fileCountLabel, isAnchored,
  namesAPath, parseLines, patternOptions, splitKnown, targetName, theseNamePatterns, thesePatterns, trackedNote,
} from "./ignoreRules";

const lines = (path: string, isDir = false) => Object.fromEntries(patternOptions({ path, isDir }).map((o) => [o.kind, o.lines[0]]));

describe("pattern options", () => {
  it("gives the five options of a file in a folder", () => {
    expect(patternOptions({ path: "src/gen/api.ts", isDir: false })).toEqual([
      { kind: "file", label: "This file", lines: ["/src/gen/api.ts"] },
      { kind: "name", label: "This name anywhere", lines: ["api.ts"] },
      { kind: "ext", label: "This extension anywhere", lines: ["*.ts"] },
      { kind: "folder", label: "This folder", lines: ["/src/gen/"] },
      { kind: "folderName", label: "This folder name anywhere", lines: ["gen/"] },
    ]);
  });

  it("leaves out the folder options for a file at the root", () => {
    expect(lines("notes.txt")).toEqual({ file: "/notes.txt", name: "notes.txt", ext: "*.txt" });
  });

  it("leaves out the extension of a dotfile without one, and of a name that ends with a dot", () => {
    expect(lines(".env")).toEqual({ file: "/.env", name: ".env" });
    expect(lines("a/b.")).toEqual({ file: "/a/b.", name: "b.", folder: "/a/", folderName: "a/" });
  });

  it("takes the last extension", () => {
    expect(extensionOf("api.test.ts")).toBe("ts");
    expect(extensionOf(".eslintrc.json")).toBe("json");
    expect(extensionOf("Makefile")).toBe("");
  });

  it("gives the two folder options of a folder", () => {
    expect(patternOptions({ path: "web/dist", isDir: true })).toEqual([
      { kind: "folder", label: "This folder", lines: ["/web/dist/"] },
      { kind: "folderName", label: "This folder name anywhere", lines: ["dist/"] },
    ]);
    expect(lines("dist/", true)).toEqual({ folder: "/dist/", folderName: "dist/" });
  });

  it("selects the file for a file and the folder for a folder", () => {
    expect(defaultKind({ path: "a/b.ts", isDir: false })).toBe("file");
    expect(defaultKind({ path: "a", isDir: true })).toBe("folder");
  });
});

describe("escape", () => {
  it("escapes the special characters of a segment", () => {
    expect(escapeSegment("#notes")).toBe("\\#notes");
    expect(escapeSegment("!keep")).toBe("\\!keep");
    expect(escapeSegment("a[1]*?")).toBe("a\\[1\\]\\*\\?");
    expect(escapeSegment("back\\slash")).toBe("back\\\\slash");
  });

  it("escapes a leading space and the trailing spaces", () => {
    expect(escapeSegment(" lead")).toBe("\\ lead");
    expect(escapeSegment("end  ")).toBe("end\\ \\ ");
    expect(escapeSegment(" ")).toBe("\\ ");
    expect(escapeSegment("in side")).toBe("in side");
  });

  it("escapes every segment of a path, not the slashes", () => {
    expect(lines("src/#gen/a[1].ts").file).toBe("/src/\\#gen/a\\[1\\].ts");
    expect(lines("src/#gen/a[1].ts").folderName).toBe("\\#gen/");
    expect(lines("x/a[1].ts").ext).toBe("*.ts");
  });

  it("matches the real file after the escape", () => {
    const path = "src/#gen/a[1]!.ts";
    for (const o of patternOptions({ path, isDir: false })) {
      expect(countMatches([path], new Set(), o.lines, false), o.label).toEqual({ matched: 1, tracked: 0 });
    }
  });
});

describe("these files", () => {
  it("gives one line for each item and a slash for a folder", () => {
    expect(thesePatterns([{ path: "a/b.ts", isDir: false }, { path: "out", isDir: true }, { path: "a/b.ts", isDir: false }])).toEqual(["/a/b.ts", "/out/"]);
  });
});

describe("custom text", () => {
  it("makes one pattern for each non-empty line", () => {
    expect(parseLines("*.log\r\n\n  \nbuild/\n")).toEqual(["*.log", "build/"]);
    expect(parseLines("")).toEqual([]);
  });
});

describe("match count", () => {
  const files = ["README.md", "src/gen/api.ts", "src/gen/types.ts", "src/app/api.ts", "src/main.ts", "lib/gen/x.ts"];
  const tracked = new Set(["src/main.ts", "src/gen/api.ts"]);
  const count = (...l: string[]) => countMatches(files, tracked, l, false);

  it("counts a file", () => {
    expect(count("/src/gen/api.ts")).toEqual({ matched: 1, tracked: 1 });
  });
  it("counts a name anywhere", () => {
    expect(count("api.ts")).toEqual({ matched: 2, tracked: 1 });
  });
  it("counts an extension anywhere", () => {
    expect(count("*.ts")).toEqual({ matched: 5, tracked: 2 });
  });
  it("counts the files in the subfolders of a folder", () => {
    expect(count("/src/")).toEqual({ matched: 4, tracked: 2 });
    expect(count("/src/gen/")).toEqual({ matched: 2, tracked: 1 });
  });
  it("counts a folder name anywhere", () => {
    expect(count("gen/")).toEqual({ matched: 3, tracked: 1 });
  });
  it("counts several lines together", () => {
    expect(count("/README.md", "/src/main.ts")).toEqual({ matched: 2, tracked: 1 });
  });
  it("counts nothing for a comment or no line", () => {
    expect(count("# note")).toEqual({ matched: 0, tracked: 0 });
    expect(count()).toEqual({ matched: 0, tracked: 0 });
  });
  it("gives no count without a list or for a list that is too long", () => {
    expect(countMatches(null, tracked, ["*.ts"], false)).toBeNull();
    expect(countMatches(new Array<string>(MAX_COUNTED_FILES + 1).fill("a"), tracked, ["*.ts"], false)).toBeNull();
    expect(countMatches(new Array<string>(MAX_COUNTED_FILES).fill("a.ts"), tracked, ["*.ts"], false)?.matched).toBe(MAX_COUNTED_FILES);
  });
  it("matches case when the repo does (core.ignorecase unset or false)", () => {
    const mixed = ["a.log", "A.LOG", "dir/B.Log", "Gen/x.ts", "gen/y.ts"];
    const cased = new Set(["A.LOG"]);
    expect(countMatches(mixed, cased, ["*.log"], false)).toEqual({ matched: 1, tracked: 0 });
    expect(countMatches(mixed, cased, ["gen/"], false)).toEqual({ matched: 1, tracked: 0 });
    expect(countMatches(mixed, cased, ["/a.log"], false)).toEqual({ matched: 1, tracked: 0 });
  });
  it("ignores case when the repo does (core.ignorecase true)", () => {
    const mixed = ["a.log", "A.LOG", "dir/B.Log", "Gen/x.ts", "gen/y.ts"];
    const cased = new Set(["A.LOG"]);
    expect(countMatches(mixed, cased, ["*.log"], true)).toEqual({ matched: 3, tracked: 1 });
    expect(countMatches(mixed, cased, ["gen/"], true)).toEqual({ matched: 2, tracked: 0 });
  });
  it("writes the label", () => {
    expect(fileCountLabel(1)).toBe("1 file");
    expect(fileCountLabel(0)).toBe("0 files");
    expect(fileCountLabel(84)).toBe("84 files");
  });
});

describe("lines that the file holds", () => {
  it("splits the lines into new and known ones", () => {
    expect(splitKnown("*.log\r\nbuild/\n", ["*.log", "dist/", "dist/", "build/"])).toEqual({ fresh: ["dist/"], known: ["*.log", "build/"] });
    expect(splitKnown("", ["a"])).toEqual({ fresh: ["a"], known: [] });
  });
  it("compares the whole line", () => {
    expect(splitKnown("/src/gen/api.ts.bak\n", ["/src/gen/api.ts"]).fresh).toEqual(["/src/gen/api.ts"]);
  });
});

describe("texts", () => {
  it("words the tracked note", () => {
    expect(trackedNote(0)).toBeNull();
    expect(trackedNote(1)).toBe("This file is tracked. Git ignores only untracked files.");
    expect(trackedNote(3)).toBe("3 matching files are tracked. Git ignores only untracked files.");
  });
  it("words the toast title", () => {
    expect(addedTitle(["/a.ts"], ".gitignore")).toBe("Added /a.ts to .gitignore");
    expect(addedTitle(["/a.ts", "/b.ts"], ".gitignore")).toBe("Added 2 patterns to .gitignore");
  });
});

describe("the global ignore file", () => {
  it("knows which options name a path of the repository", () => {
    expect(["file", "folder", "these"].every((k) => isAnchored(k as never))).toBe(true);
    expect(["name", "ext", "folderName", "theseNames", "custom"].some((k) => isAnchored(k as never))).toBe(false);
    // Every option that stays on the global file is a name or an extension pattern.
    for (const item of [{ path: "src/gen/api.ts", isDir: false }, { path: "build/out", isDir: true }]) {
      for (const o of patternOptions(item)) if (!isAnchored(o.kind)) expect(o.lines.some(namesAPath), o.kind).toBe(false);
    }
  });

  it("turns several items into names", () => {
    expect(theseNamePatterns([{ path: "src/a.ts", isDir: false }, { path: "lib/a.ts", isDir: false }, { path: "build/", isDir: true }, { path: "x/#tmp", isDir: false }])).toEqual([
      "a.ts",
      "build/",
      "\\#tmp",
    ]);
  });

  it("sees a path in a line", () => {
    expect(namesAPath("/a.ts")).toBe(true);
    expect(namesAPath("src/a.ts")).toBe(true);
    expect(namesAPath("!src/a.ts")).toBe(true);
    expect(namesAPath("build/")).toBe(false);
    expect(namesAPath("*.log")).toBe(false);
  });

  it("words the three targets honestly", () => {
    expect(targetName("gitignore")).toBe(".gitignore");
    expect(targetName("exclude")).toBe(".git/info/exclude");
    expect(targetName("global")).toBe("the global ignore file");
    expect(TARGET_LABEL.exclude).toContain("not shared");
    expect(TARGET_LABEL.global).toContain("All repositories");
    expect(TARGET_SCOPE.exclude).not.toMatch(/every repository/);
    expect(TARGET_SCOPE.global).toContain("every repository");
    expect(addedBody("gitignore", "web", "web/.gitignore")).toBe("web/.gitignore. Commit it when you are ready.");
    expect(addedBody("exclude", "web", ".git/info/exclude")).toBe(".git/info/exclude of web. The rule stays on this computer.");
    expect(addedBody("global", "web", "/home/u/.config/git/ignore")).toBe("/home/u/.config/git/ignore. It applies to every repository on this computer.");
  });
});
