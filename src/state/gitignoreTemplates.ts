/**
 * The gitignore templates ("Gitignore templates" dialog): the list with its groups, the scan that finds the templates a
 * repository needs, and the plan of what a set of templates adds to an ignore file. Pure: no DOM, no Solid, no API.
 * The data is in `gitignoreTemplateData.ts`.
 */
import ignore from "ignore";
import { hasHeader, isPatternLine, needsGap, placeBlocks, textLines } from "../api/ignoreBlocks";
import type { FileList, IgnoreBlock } from "../api/types";
import { TEMPLATE_DEFS, TEMPLATE_GROUPS, type TemplateDef, type TemplateGroup } from "./gitignoreTemplateData";

export { TEMPLATE_GROUPS, type TemplateDef, type TemplateGroup };

export interface Template extends TemplateDef {
  /** The marker comment of the block in the ignore file. */
  header: string;
  /** The lines of the block (patterns, comments and empty lines), without the header. */
  lines: string[];
}

/** The marker line of a template: the file holds it once the template was added. */
export const templateHeader = (name: string): string => `# --- DeepGit template: ${name} ---`;

/** The lines of a raw template: no trailing spaces, no empty line at the ends, and one empty line at most between groups. */
export function parseRules(rules: string): string[] {
  const out: string[] = [];
  for (const raw of rules.split("\n")) {
    const l = raw.trimEnd();
    if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(l);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** Every template, in the order of the groups: languages, build tools, IDEs and editors, operating systems. */
export const TEMPLATES: readonly Template[] = TEMPLATE_DEFS.map((d) => ({ ...d, header: templateHeader(d.name), lines: parseRules(d.rules) }));

export const templateById = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

/** The templates of a group. */
export const templatesOf = (group: TemplateGroup): Template[] => TEMPLATES.filter((t) => t.group === group);

/** The number of patterns of a template (comments and empty lines do not count). */
export const patternCount = (t: Template): number => t.lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).length;

// ---------------------------------------------------------------- the scan

/** What the scan found. `ids` follow the order of `TEMPLATES`. */
export interface Detection {
  ids: string[];
  /** Why each template was found: the first file or folder, and how many more matched. */
  reasons: Record<string, string>;
  /** The file list was cut: a template may have been missed. */
  incomplete: boolean;
}

/** File names (lower case) that point to a template. */
const NAME_MARKERS: Record<string, string[]> = {
  "cargo.toml": ["rust"],
  "pom.xml": ["maven", "java"],
  "build.gradle": ["gradle"],
  "build.gradle.kts": ["gradle"],
  "settings.gradle": ["gradle"],
  "settings.gradle.kts": ["gradle"],
  gradlew: ["gradle"],
  "cmakelists.txt": ["cmake"],
  "pyproject.toml": ["python"],
  "setup.py": ["python"],
  "setup.cfg": ["python"],
  pipfile: ["python"],
  "poetry.lock": ["python"],
  "tox.ini": ["python"],
  "package.json": ["node"],
  "go.mod": ["go"],
};

/** Extensions (lower case, without the dot) that point to a template. `c` and `cpp` are decided at the end (C++ wins). */
const EXT_MARKERS: Record<string, string> = {
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  py: "python",
  sln: "dotnet",
  csproj: "dotnet",
  vcxproj: "dotnet",
  fsproj: "dotnet",
  vbproj: "dotnet",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
};

/** Folders (lower case) that point to a template, at any depth. */
const DIR_MARKERS: Record<string, string> = { ".idea": "jetbrains", ".vscode": "vscode" };

/**
 * Folders (lower case) that hold the files of other people's code or generated files: dependencies, caches, build output.
 * The scan does not look inside them, so a `package.json` in `node_modules/` or a `.py` in `.venv/` is not a sign.
 */
const DEPENDENCY_DIRS = new Set([
  "node_modules", "bower_components", "jspm_packages", "web_modules",
  ".venv", "venv", ".tox", ".nox", "__pycache__", "site-packages", ".mypy_cache", ".pytest_cache",
  "vendor", "third_party", "third-party", "thirdparty", "pods", "carthage",
  "target", "build", "dist", ".gradle", ".next", ".nuxt", ".git",
]);

/** A language that only source files point to is found from this many of them (a single script in a repo is not a Python project). */
const SOURCE_FILES_NEEDED: Record<string, number> = { python: 3 };

/**
 * Finds the templates that a file list calls for (a repository that the user scans on purpose). It reads the files and the
 * ignored entries: a folder that is ignored already (`.idea/`) is still there. Markers are matched at any depth, so a
 * monorepo finds the tools of its sub-projects, except inside the folders of `DEPENDENCY_DIRS` (`node_modules/`, `.venv/`,
 * `vendor/`, `target/`, `build/`...), which are skipped.
 *
 *  - `Cargo.toml` Rust, `pom.xml` Maven and Java, `build.gradle(.kts)`, `settings.gradle(.kts)` or `gradlew` Gradle,
 *    `CMakeLists.txt` CMake, `package.json` Node.js, `go.mod` Go, `*.sln`, `*.csproj`, `*.vcxproj` .NET.
 *  - Python: `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt`, `Pipfile`, `poetry.lock` or `tox.ini`, or at least
 *    3 `*.py` files. One script is not enough.
 *  - Unity: `ProjectSettings/ProjectVersion.txt` at the root of the repository (the Unity rules start at the root). A Unity
 *    project makes `*.sln` and `*.csproj` files itself, so it is not called .NET.
 *  - `*.java` Java, `*.kt` and `*.kts` Kotlin (a `*.gradle.kts` script is Gradle, not Kotlin), `*.cpp`, `*.cc`, `*.cxx`, `*.hpp`
 *    C++, `*.c` C. Headers (`*.h`) do not count: they are C, C++ and Objective-C alike. A repository with C++ sources is C++ only.
 *  - `.idea/` JetBrains, `.vscode/` Visual Studio Code.
 *  - Operating system templates are never found. The user picks them.
 */
export function detectTemplates(list: Pick<FileList, "files" | "ignored" | "truncated">): Detection {
  const hits = new Map<string, { first: string; count: number }>();
  const few = new Map<string, { first: string; count: number }>();
  const add = (into: Map<string, { first: string; count: number }>, id: string, path: string): void => {
    const h = into.get(id);
    if (h) h.count++;
    else into.set(id, { first: path, count: 1 });
  };

  const look = (path: string): void => {
    const isDir = path.endsWith("/");
    const clean = isDir ? path.slice(0, -1) : path;
    const segs = clean.split("/");
    const name = (segs[segs.length - 1] ?? "").toLowerCase();
    const dirs = (isDir ? segs : segs.slice(0, -1)).map((d) => d.toLowerCase());
    if (dirs.some((d) => DEPENDENCY_DIRS.has(d))) return;
    for (const d of dirs) {
      const id = DIR_MARKERS[d];
      if (id) add(hits, id, d + "/");
    }
    if (isDir) return;
    for (const id of NAME_MARKERS[name] ?? []) add(hits, id, clean);
    if (name.startsWith("requirements") && name.endsWith(".txt")) add(hits, "python", clean);
    if (clean.toLowerCase() === "projectsettings/projectversion.txt") add(hits, "unity", clean);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1) : "";
    const id = EXT_MARKERS[ext];
    if (!id) return;
    if (ext === "kts" && name.endsWith(".gradle.kts")) return;
    // `setup.py` was counted as a project file already.
    if (NAME_MARKERS[name]?.includes(id)) return;
    add(SOURCE_FILES_NEEDED[id] ? few : hits, id, clean);
  };
  for (const p of list.files) look(p);
  for (const p of list.ignored) look(p);

  // Source files alone point to a language only from a number of them. A project file counts at once.
  for (const [id, h] of few) {
    const strong = hits.get(id);
    if (strong) strong.count += h.count;
    else if (h.count >= SOURCE_FILES_NEEDED[id]) hits.set(id, h);
  }
  // C++ has the C files and headers too. Unity makes the .NET project files itself.
  if (hits.has("cpp")) hits.delete("c");
  if (hits.has("unity")) hits.delete("dotnet");

  const ids = TEMPLATES.filter((t) => hits.has(t.id)).map((t) => t.id);
  const reasons: Record<string, string> = {};
  for (const id of ids) {
    const h = hits.get(id);
    if (h) reasons[id] = h.count > 1 ? `${h.first} and ${h.count - 1} more` : h.first;
  }
  return { ids, reasons, incomplete: list.truncated };
}

// ---------------------------------------------------------------- the plan

/** What one template does to an ignore file: `present` (its block is there already), `covered` (every pattern is there), or `new`. */
export type TemplateState = "present" | "covered" | "new";

export interface TemplateEntry {
  id: string;
  state: TemplateState;
  /** The lines that go into the file under the header (state `new`), the same that the backend keeps. Else empty. */
  lines: string[];
  /** How many patterns are new (state `new`). */
  added: number;
}

/** Blocks that go to one place of the file. */
export interface PreviewGroup {
  /** The name of the template block of the file that these go before. Null: at the end of the file. */
  before: string | null;
  /** Header and lines of each block, an empty line between blocks (and one first at the end of a file that needs it). */
  lines: string[];
}

export interface TemplatePlan {
  /** One entry for each picked template, in the order of `TEMPLATES`. */
  entries: TemplateEntry[];
  /** The blocks to send to `appendIgnoreBlocks`: the picked templates that are `new`. */
  blocks: IgnoreBlock[];
  /** Where the lines go, in file order. */
  groups: PreviewGroup[];
  /** The lines of all groups, in file order. */
  preview: string[];
  /** Rules that would hide a file that a line of the file keeps (`!name`). Empty most of the time. */
  warnings: string[];
}

/** The headers of every template in the order of the dialog: what `appendIgnoreBlocks` takes as `order`. */
export const TEMPLATE_ORDER: readonly string[] = TEMPLATES.map((t) => t.header);

/** The state of every template for the text of an ignore file. A template stays `present` while its header is in the file. */
export function presentIds(existing: string): Set<string> {
  return new Set(TEMPLATES.filter((t) => hasHeader(existing, t.header)).map((t) => t.id));
}

const nameOfHeader = (header: string): string => TEMPLATES.find((t) => t.header === header)?.name ?? header;

/** The file that a `!literal` line keeps, or null when the line has a glob (the check needs a name). */
const keptName = (line: string): string | null => {
  const t = line.trim();
  if (!t.startsWith("!")) return null;
  const name = t.slice(1).replace(/^\//, "");
  return name === "" || /[*?[\\]/.test(name) ? null : name;
};

/** The first pattern of `lines` that matches `name`, or null. */
function hidingPattern(lines: readonly string[], name: string): string | null {
  for (const l of lines) {
    if (!isPatternLine(l) || l.trim().startsWith("!")) continue;
    try {
      if (ignore().add(l).ignores(name)) return l;
    } catch {
      // A name that `ignore` refuses is no name to check.
    }
  }
  return null;
}

/**
 * What adding `picked` to a file with the text `existing` does. The rules are those of `append_ignore_blocks` (`placeBlocks`): a
 * template whose header is in the file is skipped, a pattern that the file or an earlier template holds is left out (with the
 * comment above it when no pattern is left under it), a template with no new pattern is `covered`, and a new block goes before
 * the first template block of the file that comes later in the list, else at the end. `warnings` names a new rule that comes
 * after a `!name` line of the file and hides that name again. `canInsert` is `IgnoreFile.canInsert`: false puts every block at the end.
 */
export function planTemplates(existing: string, picked: ReadonlySet<string>, canInsert = true): TemplatePlan {
  const chosen = TEMPLATES.filter((t) => picked.has(t.id));
  const fresh = chosen.filter((t) => !hasHeader(existing, t.header));
  const { placed } = placeBlocks(existing, fresh.map((t) => ({ header: t.header, lines: t.lines })), TEMPLATE_ORDER, canInsert);
  const placedBy = new Map(placed.map((p) => [p.header, p]));

  const entries: TemplateEntry[] = chosen.map((t) => {
    const p = placedBy.get(t.header);
    if (hasHeader(existing, t.header)) return { id: t.id, state: "present", lines: [], added: 0 };
    if (!p) return { id: t.id, state: "covered", lines: [], added: 0 };
    return { id: t.id, state: "new", lines: p.lines, added: p.lines.filter(isPatternLine).length };
  });
  const blocks = placed.map((p) => ({ header: p.header, lines: TEMPLATES.find((t) => t.header === p.header)?.lines ?? [] }));

  const old = textLines(existing);
  if (old[old.length - 1] === "") old.pop();
  const lineOf = (before: string | null): number => (before === null ? old.length : old.findIndex((l) => l.trimEnd() === before));
  const groups: PreviewGroup[] = [];
  for (const p of [...placed].sort((a, b) => lineOf(a.before) - lineOf(b.before))) {
    let g = groups.find((x) => x.before === p.before);
    if (!g) {
      g = { before: p.before, lines: p.before === null && needsGap(existing) ? [""] : [] };
      groups.push(g);
    } else g.lines.push("");
    g.lines.push(p.header, ...p.lines);
  }

  const warnings = new Set<string>();
  for (const p of placed) {
    const upTo = lineOf(p.before);
    for (const l of old.slice(0, upTo)) {
      const name = keptName(l);
      const hides = name === null ? null : hidingPattern(p.lines, name);
      if (name !== null && hides !== null) {
        warnings.add(`${hides} of the ${nameOfHeader(p.header)} template hides ${name}, which your line ${l.trim()} keeps: the new rule comes after that line. Move the line below it after you add the template.`);
      }
    }
  }
  return { entries, blocks, groups, preview: groups.flatMap((g) => g.lines), warnings: [...warnings] };
}

/** `Add 3 templates`, `Add Rust`. */
export function addLabel(plan: TemplatePlan): string {
  const names = plan.entries.filter((e) => e.state === "new").map((e) => templateById(e.id)?.name ?? e.id);
  if (names.length === 0) return "Add";
  return names.length === 1 ? `Add ${names[0]}` : `Add ${names.length} templates`;
}

/** The name of the template that a block header stands for (the header itself for an unknown one). */
export { nameOfHeader as templateNameOfHeader };

/** The title of the success toast. */
export function addedTemplatesTitle(headers: readonly string[], targetName: string): string {
  const names = headers.map((h) => TEMPLATES.find((t) => t.header === h)?.name ?? h);
  return names.length === 1 ? `Added the ${names[0]} template to ${targetName}` : `Added ${names.length} templates to ${targetName}`;
}
