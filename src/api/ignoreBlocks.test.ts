import { describe, expect, it } from "vitest";
import { appendIgnoreBlocks, blockError, dominantEol, hasHeader, isPatternLine, needsGap, placeBlocks, textLines, tidyBlock } from "./ignoreBlocks";

const RUST = "# --- DeepGit template: Rust ---";
const JAVA = "# --- DeepGit template: Java ---";

describe("tidyBlock", () => {
  it("leaves out the known patterns, and the comments that have no pattern left", () => {
    const known = new Set(["*.log", "dist/"]);
    const lines = ["# Logs", "*.log", "", "# Output", "dist/", "build/", "", "# Cache", ".cache/", "*.log"];
    expect(tidyBlock(lines, known)).toEqual(["# Output", "build/", "", "# Cache", ".cache/"]);
    // What stayed is known now.
    expect(tidyBlock(lines, known)).toEqual([]);
  });

  it("is empty when no pattern is new", () => {
    expect(tidyBlock(["# c", "a", "", "a"], new Set(["a"]))).toEqual([]);
    expect(tidyBlock(["# only a comment", ""], new Set())).toEqual([]);
  });

  it("keeps a negation and an escaped hash as patterns", () => {
    expect(tidyBlock(["!keep.jar", "\\#file"], new Set())).toEqual(["!keep.jar", "\\#file"]);
    expect(isPatternLine("\\#file")).toBe(true);
    expect(isPatternLine("# note")).toBe(false);
    expect(isPatternLine("  ")).toBe(false);
  });
});

describe("hasHeader", () => {
  it("finds the header line, also with CRLF and trailing spaces", () => {
    expect(hasHeader(`a\n${RUST}\nb\n`, RUST)).toBe(true);
    expect(hasHeader(`a\r\n${RUST}  \r\n`, RUST)).toBe(true);
    expect(hasHeader(`a\n${RUST} more\n`, RUST)).toBe(false);
    expect(hasHeader("", RUST)).toBe(false);
  });
});

describe("needsGap", () => {
  it("is true only when the last line has text", () => {
    expect(needsGap("")).toBe(false);
    expect(needsGap("\n")).toBe(false);
    expect(needsGap("a\n\n")).toBe(false);
    expect(needsGap("a\n")).toBe(true);
    expect(needsGap("a")).toBe(true);
    expect(needsGap("a\r\n  \r\n")).toBe(false);
  });
});

describe("appendIgnoreBlocks", () => {
  it("adds each block after an empty line and its header", () => {
    const r = appendIgnoreBlocks("node_modules/\n", [
      { header: RUST, lines: ["# Cargo", "target/", "", "*.pdb"] },
      { header: JAVA, lines: ["*.class"] },
    ]);
    expect(r.added).toEqual([RUST, JAVA]);
    expect(r.text).toBe(`node_modules/\n\n${RUST}\n# Cargo\ntarget/\n\n*.pdb\n\n${JAVA}\n*.class\n`);
  });

  it("starts a new file without an empty line, and keeps the line end of the file", () => {
    expect(appendIgnoreBlocks("", [{ header: RUST, lines: ["target/"] }]).text).toBe(`${RUST}\ntarget/\n`);
    expect(appendIgnoreBlocks("*.log\r\nbuild", [{ header: JAVA, lines: ["*.class"] }]).text).toBe(`*.log\r\nbuild\r\n\r\n${JAVA}\r\n*.class\r\n`);
  });

  it("skips a block that is there, and leaves out known patterns", () => {
    const text = `${RUST}\ntarget/\n\n*.class\n`;
    const r = appendIgnoreBlocks(text, [
      { header: RUST, lines: ["target/", "new/"] },
      { header: JAVA, lines: ["# Classes", "*.class", "", "# Dumps", "hs_err_pid*"] },
    ]);
    expect(r.added).toEqual([JAVA]);
    expect(r.text).toBe(`${text}\n${JAVA}\n# Dumps\nhs_err_pid*\n`);
    expect(appendIgnoreBlocks(r.text, [{ header: JAVA, lines: ["hs_err_pid*"] }])).toEqual({ text: r.text, added: [] });
  });

  it("skips a block with no new pattern and does not repeat a pattern between blocks", () => {
    const r = appendIgnoreBlocks("target/\n", [
      { header: RUST, lines: ["target/"] },
      { header: JAVA, lines: ["*.log"] },
      { header: "# --- DeepGit template: Python ---", lines: ["*.log", "*.pyc"] },
    ]);
    expect(r.added).toEqual([JAVA, "# --- DeepGit template: Python ---"]);
    expect(r.text).toBe(`target/\n\n${JAVA}\n*.log\n\n# --- DeepGit template: Python ---\n*.pyc\n`);
  });

  it("refuses a header that is not a comment and a line break", () => {
    expect(blockError({ header: "target/", lines: [] })).toBe("The header of a block must be a comment.");
    expect(blockError({ header: RUST, lines: ["a\nb"] })).toContain("line break");
    expect(blockError({ header: "# a\nb", lines: [] })).toContain("line break");
    expect(blockError({ header: RUST, lines: ["a", ""] })).toBeNull();
  });
});

describe("placeBlocks (the same cases as the backend tests in crates/gitcore/tests/files.rs)", () => {
  const GRADLE = "# --- DeepGit template: Gradle ---";
  const LINUX = "# --- DeepGit template: Linux ---";
  const ORDER = [JAVA, RUST, GRADLE, LINUX];

  it("puts a new block before the first block of the file that comes later in the order", () => {
    const first = appendIgnoreBlocks("", [{ header: GRADLE, lines: ["*.jar", "!gradle-wrapper.jar"] }], ORDER).text;
    const r = appendIgnoreBlocks(first, [{ header: JAVA, lines: ["# Archives", "*.jar", "*.war"] }], ORDER);
    expect(r.added).toEqual([JAVA]);
    expect(r.text).toBe(`${JAVA}\n# Archives\n*.war\n\n${GRADLE}\n*.jar\n!gradle-wrapper.jar\n`);
  });

  it("keeps the order of the templates, inside the file and at its end, whatever order they come in", () => {
    const first = appendIgnoreBlocks("mine/\n", [{ header: LINUX, lines: ["*~"] }], ORDER).text;
    const r = appendIgnoreBlocks(first, [{ header: RUST, lines: ["target/"] }, { header: JAVA, lines: ["*.class"] }], ORDER);
    expect(r.added).toEqual([JAVA, RUST]);
    expect(r.text).toBe(`mine/\n\n${JAVA}\n*.class\n\n${RUST}\ntarget/\n\n${LINUX}\n*~\n`);
    // A header that is not in the order goes to the end.
    const more = appendIgnoreBlocks(r.text, [{ header: "# --- DeepGit template: Other ---", lines: ["x/"] }], ORDER).text;
    expect(more.endsWith("\n\n# --- DeepGit template: Other ---\nx/\n")).toBe(true);
  });

  it("keeps CRLF and the last line when it inserts", () => {
    const r = appendIgnoreBlocks(`a\r\n${LINUX}\r\n*~\r\nlast`, [{ header: JAVA, lines: ["*.class"] }], ORDER);
    // The last line has no line end and keeps none.
    expect(r.text).toBe(`a\r\n\r\n${JAVA}\r\n*.class\r\n\r\n${LINUX}\r\n*~\r\nlast`);
  });

  it("says where each block went", () => {
    const text = `${LINUX}\n*~\n`;
    const { placed } = placeBlocks(text, [{ header: JAVA, lines: ["*.class"] }, { header: "# --- DeepGit template: Other ---", lines: ["x/"] }], ORDER);
    expect(placed.map((p) => [p.header, p.before])).toEqual([[JAVA, LINUX], ["# --- DeepGit template: Other ---", null]]);
  });

  it("does not add a block twice", () => {
    const text = appendIgnoreBlocks(`${LINUX}\n*~\n`, [{ header: JAVA, lines: ["*.class"] }], ORDER).text;
    expect(appendIgnoreBlocks(text, [{ header: JAVA, lines: ["*.class", "*.new"] }], ORDER)).toEqual({ text, added: [] });
  });
});

describe("line ends, byte order mark, other encodings (same cases as crates/gitcore/tests/files.rs)", () => {
  const LINUX = "# --- DeepGit template: Linux ---";
  const ORDER = [JAVA, RUST, LINUX];
  const java = [{ header: JAVA, lines: ["*.class"] }];

  it("picks the dominant line end", () => {
    expect(dominantEol("")).toBe("\n");
    expect(dominantEol("a\nb\n")).toBe("\n");
    expect(dominantEol("a\r\nb\r\n")).toBe("\r\n");
    expect(dominantEol("a\r\nb\n")).toBe("\r\n");
    expect(dominantEol("a\r\nb\nc\n")).toBe("\n");
    expect(dominantEol("a\r\nb")).toBe("\r\n");
  });

  it("keeps every existing line as it is, and writes the new ones with the dominant end", () => {
    expect(appendIgnoreBlocks(`a\nb\nc\n${LINUX}\r\n*~\r\n`, java, ORDER).text).toBe(`a\nb\nc\n\n${JAVA}\n*.class\n\n${LINUX}\r\n*~\r\n`);
    expect(appendIgnoreBlocks(`a\r\nb\r\nc\n${LINUX}\r\n*~\r\n`, java, ORDER).text).toBe(
      `a\r\nb\r\nc\n\r\n${JAVA}\r\n*.class\r\n\r\n${LINUX}\r\n*~\r\n`,
    );
    // At the end of a mixed text too.
    expect(appendIgnoreBlocks("a\nb\nc\nd\r\ne", [{ header: RUST, lines: ["x/"] }], ORDER).text).toBe(`a\nb\nc\nd\r\ne\n\n${RUST}\nx/\n`);
  });

  it("keeps a byte order mark first, and does not let it hide the first line", () => {
    expect(textLines("\ufeffa\nb")).toEqual(["a", "b"]);
    expect(hasHeader(`\ufeff${RUST}\n`, RUST)).toBe(true);
    const text = `\ufeff${LINUX}\n*~\n`;
    expect(appendIgnoreBlocks(text, [{ header: LINUX, lines: ["*~", "new"] }], ORDER)).toEqual({ text, added: [] });
    expect(appendIgnoreBlocks(text, java, ORDER).text).toBe(`\ufeff${JAVA}\n*.class\n\n${LINUX}\n*~\n`);
    // A pattern on the first line behind the mark is held already.
    const r = appendIgnoreBlocks("\ufefftarget/\n", [{ header: RUST, lines: ["target/", "*.pdb"] }], ORDER);
    expect(r.text).toBe(`\ufefftarget/\n\n${RUST}\n*.pdb\n`);
    expect(needsGap("\ufefftarget/\n")).toBe(true);
  });

  it("puts every block at the end when the file cannot be inserted into (not UTF-8)", () => {
    const text = `${LINUX}\n*~\n`;
    const r = placeBlocks(text, java, ORDER, false);
    expect(r.placed.map((p) => p.before)).toEqual([null]);
    expect(r.text).toBe(`${text}\n${JAVA}\n*.class\n`);
    expect(placeBlocks(text, java, ORDER, true).placed.map((p) => p.before)).toEqual([LINUX]);
  });

  it("returns the headers without trailing space", () => {
    expect(appendIgnoreBlocks("", [{ header: `${JAVA}  `, lines: ["*.class"] }], ORDER)).toEqual({ text: `${JAVA}\n*.class\n`, added: [JAVA] });
  });
});
