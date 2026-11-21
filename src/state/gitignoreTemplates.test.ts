import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { appendIgnoreBlocks } from "../api/ignoreBlocks";
import type { FileList } from "../api/types";
import {
  TEMPLATES, TEMPLATE_GROUPS, TEMPLATE_ORDER, addLabel, addedTemplatesTitle, detectTemplates, parseRules, patternCount, planTemplates, presentIds, templateById,
  templateHeader, templatesOf,
} from "./gitignoreTemplates";

const list = (files: string[], ignored: string[] = [], truncated = false): FileList => ({ files, ignored, truncated });
const detect = (files: string[], ignored: string[] = [], truncated = false) => detectTemplates(list(files, ignored, truncated)).ids;
const ids = (...s: string[]) => new Set(s);

describe("the template data", () => {
  it("has the templates the app promises, in four groups and in order", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      "java", "kotlin", "rust", "c", "cpp", "python", "node", "go", "dotnet", "unity",
      "maven", "gradle", "cmake", "jetbrains", "vscode", "macos", "windows", "linux",
    ]);
    expect(TEMPLATE_GROUPS.map((g) => g.id)).toEqual(["languages", "build", "ides", "os"]);
    expect(templatesOf("build").map((t) => t.id)).toEqual(["maven", "gradle", "cmake"]);
    expect(templatesOf("ides").map((t) => t.name)).toEqual(["JetBrains (IntelliJ)", "Visual Studio Code"]);
    expect(templatesOf("os").map((t) => t.name)).toEqual(["macOS", "Windows", "Linux"]);
    // A group is a run: the blocks of a group stay together in the file.
    const order = TEMPLATES.map((t) => TEMPLATE_GROUPS.findIndex((g) => g.id === t.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("has unique ids, names and headers, and a header that the file can hold", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => t.header)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      expect(t.header).toBe(templateHeader(t.name));
      expect(t.header.startsWith("# ")).toBe(true);
      expect(t.summary.length).toBeGreaterThan(10);
    }
  });

  it("has clean lines: patterns, comments, single empty lines, no line break or trailing space", () => {
    for (const t of TEMPLATES) {
      expect(patternCount(t), t.id).toBeGreaterThanOrEqual(5);
      expect(t.lines[0], t.id).not.toBe("");
      expect(t.lines[t.lines.length - 1], t.id).not.toBe("");
      t.lines.forEach((l, i) => {
        expect(/[\r\n\0]/.test(l), `${t.id}: ${l}`).toBe(false);
        expect(l, `${t.id}: ${l}`).toBe(l.trimEnd());
        if (l === "") expect(t.lines[i - 1], t.id).not.toBe("");
      });
      // Every comment line sits above a pattern: no comment closes a group or the template.
      t.lines.forEach((l, i) => {
        if (l.startsWith("#")) expect(t.lines[i + 1] ?? "", `${t.id}: ${l}`).not.toBe("");
      });
      expect(() => ignore().add(t.lines), t.id).not.toThrow();
      expect(new Set(t.lines.filter((l) => l !== "" && !l.startsWith("#"))).size, `${t.id} repeats a pattern`).toBe(patternCount(t));
    }
  });

  it("keeps the wrapper jar of Gradle after the jar rule of Java in the file", () => {
    const text = appendIgnoreBlocks("", planTemplates("", ids("gradle", "java")).blocks).text;
    expect(text.indexOf("*.jar")).toBeLessThan(text.indexOf("!gradle-wrapper.jar"));
    expect(ignore().add(text).ignores("gradle/wrapper/gradle-wrapper.jar")).toBe(false);
    expect(ignore().add(text).ignores("libs/other.jar")).toBe(true);
  });

  it("ignores what each template is for", () => {
    const hides = (id: string, ...paths: string[]) => {
      const rules = ignore().add(templateById(id)!.lines);
      for (const p of paths) expect(rules.ignores(p), `${id}: ${p}`).toBe(true);
    };
    hides("rust", "target/debug/app", "src/lib.rs.bk");
    hides("java", "out/A.class", "app.jar", "hs_err_pid123.log");
    hides("maven", "target/classes/A.class", "pom.xml.tag");
    hides("python", "pkg/__pycache__/a.pyc", ".venv/bin/python", "dist/x.whl");
    hides("node", "node_modules/a/index.js", ".env", "dist/app.js");
    hides("go", "app.exe", "pkg/x.test");
    hides("c", "main.o", "libx.so", "a.out");
    hides("cmake", "build/Makefile", "CMakeCache.txt", "CMakeFiles/x");
    hides("jetbrains", ".idea/workspace.xml", ".idea/dataSources/a.xml", "x.iws");
    hides("vscode", ".vscode/other.json", "ext.vsix");
    hides("dotnet", "bin/Debug/app.dll", "obj/x.cs", ".vs/a", "App.csproj.user");
    hides("unity", "Library/a", "Temp/b", "Logs/c.log", "App.csproj");
    hides("macos", ".DS_Store", "a/._x");
    hides("windows", "Thumbs.db", "a/desktop.ini");
    hides("linux", "notes.txt~", ".directory");
    const keeps = (id: string, ...paths: string[]) => {
      const rules = ignore().add(templateById(id)!.lines);
      for (const p of paths) expect(rules.ignores(p), `${id}: ${p}`).toBe(false);
    };
    keeps("vscode", ".vscode/settings.json", ".vscode/launch.json", "a.code-workspace");
    keeps("node", ".env.example", "src/index.ts", "package-lock.json");
    keeps("rust", "Cargo.lock", "src/main.rs");
    keeps("unity", "Assets/Scripts/A.cs", "ProjectSettings/ProjectVersion.txt");
  });

  it("parses a raw template", () => {
    expect(parseRules("\n\n# a  \n\nx\n\n\n\ny\n\n")).toEqual(["# a", "", "x", "", "y"]);
    expect(parseRules("")).toEqual([]);
  });
});

describe("detectTemplates", () => {
  it("finds a language by its project file", () => {
    expect(detect(["Cargo.toml", "src/main.rs"])).toEqual(["rust"]);
    expect(detect(["package.json"])).toEqual(["node"]);
    expect(detect(["go.mod", "main.go"])).toEqual(["go"]);
    expect(detect(["CMakeLists.txt"])).toEqual(["cmake"]);
    for (const f of ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "requirements-dev.txt", "Pipfile", "poetry.lock", "tox.ini", "api/requirements.txt"]) {
      expect(detect([f]), f).toEqual(["python"]);
    }
  });

  it("needs several .py files to call a repository Python: one script is no sign", () => {
    expect(detect(["tools/release.py"])).toEqual([]);
    expect(detect(["a.py", "b.py"])).toEqual([]);
    expect(detect(["a.py", "b.py", "pkg/c.py"])).toEqual(["python"]);
    // Files in both lists count, and a project file needs no count.
    expect(detect(["a.py", "b.py"], ["c.py"])).toEqual(["python"]);
    expect(detect(["a.py", "setup.py"])).toEqual(["python"]);
  });

  it("finds Maven with Java, and Gradle by any of its files", () => {
    expect(detect(["pom.xml"])).toEqual(["java", "maven"]);
    for (const f of ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"]) expect(detect([f]), f).toEqual(["gradle"]);
    expect(detect(["app/build.gradle", "src/Main.java"])).toEqual(["java", "gradle"]);
  });

  it("finds sources by extension: Java, Kotlin, .NET", () => {
    expect(detect(["src/main/java/A.java"])).toEqual(["java"]);
    expect(detect(["src/Main.kt"])).toEqual(["kotlin"]);
    expect(detect(["scripts/run.kts"])).toEqual(["kotlin"]);
    for (const f of ["App.sln", "src/App.csproj", "native/x.vcxproj"]) expect(detect([f]), f).toEqual(["dotnet"]);
  });

  it("does not call a Gradle Kotlin script Kotlin", () => {
    expect(detect(["build.gradle.kts", "settings.gradle.kts", "app/build.gradle.kts"])).toEqual(["gradle"]);
    expect(detect(["build.gradle.kts", "src/Main.kt"])).toEqual(["kotlin", "gradle"]);
  });

  it("finds C without C++ sources, and C++ otherwise", () => {
    expect(detect(["main.c", "util.h"])).toEqual(["c"]);
    for (const f of ["a.cpp", "a.cc", "a.cxx", "a.hpp"]) expect(detect([f]), f).toEqual(["cpp"]);
    // With C++ sources, the C files are part of the C++ project.
    expect(detect(["main.c", "util.h", "app.cpp"])).toEqual(["cpp"]);
    expect(detect(["main.c", "CMakeLists.txt", "lib/x.cc"])).toEqual(["cpp", "cmake"]);
  });

  it("does not take a header for C: it can be C++ or Objective-C", () => {
    expect(detect(["util.h"])).toEqual([]);
    expect(detect(["App/AppDelegate.h", "App/AppDelegate.m", "App/util.h"])).toEqual([]);
    expect(detect(["include/lib.h", "include/more.h", "README.md"])).toEqual([]);
  });

  it("finds Unity by ProjectVersion.txt in ProjectSettings at the root only", () => {
    expect(detect(["ProjectSettings/ProjectVersion.txt", "Assets/A.cs"])).toEqual(["unity"]);
    expect(detect(["projectsettings/projectversion.txt"])).toEqual(["unity"]);
    expect(detect(["docs/ProjectVersion.txt"])).toEqual([]);
    // The Unity rules start at the root: a project in a sub-folder gets no Unity template.
    expect(detect(["game/ProjectSettings/ProjectVersion.txt"])).toEqual([]);
  });

  it("does not call a Unity project .NET: it makes the solution and project files itself", () => {
    expect(detect(["ProjectSettings/ProjectVersion.txt", "Game.sln", "Assembly-CSharp.csproj", "Assembly-CSharp-Editor.csproj"])).toEqual(["unity"]);
    // Without Unity a solution is .NET.
    expect(detect(["Game.sln", "Assembly-CSharp.csproj"])).toEqual(["dotnet"]);
  });

  it("does not look inside the folders of dependencies, caches and build output", () => {
    const inside = [
      "node_modules/left-pad/package.json", "web/node_modules/x/package.json", ".venv/lib/site-packages/a/setup.py", "venv/b/requirements.txt",
      "vendor/lib/Cargo.toml", "third_party/proj/CMakeLists.txt", "Pods/Alamofire/Sources/A.c", ".gradle/caches/x.java",
      "target/debug/build.rs.cpp", "build/gen/Main.java", "dist/app/go.mod", "app/node_modules/.bin/pom.xml",
      "node_modules/.idea/workspace.xml", "vendor/.vscode/settings.json", "Vendor/Lib/package.json",
    ];
    expect(detect(inside)).toEqual([]);
    // Many .py files in a virtual environment are no Python project.
    expect(detect(Array.from({ length: 50 }, (_, i) => `.venv/lib/m${i}.py`))).toEqual([]);
    // Ignored entries too, whole folders and files in them.
    expect(detect([], ["node_modules/", "target/", ".venv/", "build/Main.java", "sub/node_modules/"])).toEqual([]);
    // A file next to such a folder still counts.
    expect(detect(["package.json", "node_modules/a/package.json"])).toEqual(["node"]);
    // A file named like such a folder is not the folder.
    expect(detect(["notes/build"])).toEqual([]);
  });

  it("finds the IDE folders in the files and in the ignored entries", () => {
    expect(detect([".idea/workspace.xml", ".vscode/settings.json"])).toEqual(["jetbrains", "vscode"]);
    // A folder that is ignored already is one entry that ends with a slash.
    expect(detect([], [".idea/", ".vscode/"])).toEqual(["jetbrains", "vscode"]);
    expect(detect([], ["sub/.idea/"])).toEqual(["jetbrains"]);
    // A file with that name is not the folder.
    expect(detect([".vscode"])).toEqual([]);
    expect(detect(["notes.idea"])).toEqual([]);
  });

  it("looks in sub-folders and in the ignored list too", () => {
    expect(detect(["crates/core/Cargo.toml", "web/package.json"])).toEqual(["rust", "node"]);
    expect(detect(["README.md"], ["scripts/setup.py"])).toEqual(["python"]);
  });

  it("matches the markers without regard to case", () => {
    expect(detect(["CARGO.TOML", "Src/A.JAVA"])).toEqual(["java", "rust"]);
  });

  it("never finds an operating system template", () => {
    expect(detect([".DS_Store", "Thumbs.db", "notes.txt~", "desktop.ini"])).toEqual([]);
  });

  it("finds nothing in a plain repository", () => {
    expect(detectTemplates(list(["README.md", "docs/guide.md", "LICENSE"]))).toEqual({ ids: [], reasons: {}, incomplete: false });
  });

  it("says why, and passes the truncation flag on", () => {
    const d = detectTemplates(list(["a/Cargo.toml", "b/Cargo.toml", "x/setup.py", "src/Main.java", "src/B.java", "src/C.java"], [".idea/"], true));
    expect(d.reasons).toEqual({ java: "src/Main.java and 2 more", rust: "a/Cargo.toml and 1 more", python: "x/setup.py", jetbrains: ".idea/" });
    expect(d.incomplete).toBe(true);
    expect(d.ids).toEqual(["java", "rust", "python", "jetbrains"]);
  });

  it("is fast for a long list", () => {
    const files = Array.from({ length: 100_000 }, (_, i) => `src/m${i % 500}/f${i}.txt`);
    const t0 = performance.now();
    expect(detect([...files, "src/Cargo.toml"])).toEqual(["rust"]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("planTemplates", () => {
  it("makes a block of each picked template, in catalog order", () => {
    const plan = planTemplates("", ids("windows", "rust", "java"));
    expect(plan.entries.map((e) => [e.id, e.state])).toEqual([["java", "new"], ["rust", "new"], ["windows", "new"]]);
    expect(plan.blocks.map((b) => b.header)).toEqual([templateHeader("Java"), templateHeader("Rust"), templateHeader("Windows")]);
    // A block carries the whole template, the preview only what is new.
    expect(plan.blocks[1].lines).toEqual(templateById("rust")!.lines);
    expect(plan.preview[0]).toBe(templateHeader("Java"));
    expect(plan.preview).toContain("");
    expect(plan.preview).toContain("target/");
  });

  it("leaves out the patterns that the file or an earlier template has, with their comments", () => {
    const plan = planTemplates("*.log\n", ids("java", "kotlin"));
    const java = plan.entries[0];
    expect(java.lines).not.toContain("*.log");
    expect(java.lines).not.toContain("# Logs");
    expect(java.lines).toContain("*.jar");
    // Kotlin shares most of its lines with Java: only its own are new.
    const kotlin = plan.entries[1];
    expect(kotlin.state).toBe("new");
    expect(kotlin.lines).toEqual(["# Kotlin Gradle plugin data", ".kotlin/"]);
    expect(kotlin.added).toBe(1);
  });

  it("marks a template whose header is in the file as present, and one that adds nothing as covered", () => {
    const existing = `${templateHeader("Rust")}\ntarget/\n`;
    expect(presentIds(existing)).toEqual(new Set(["rust"]));
    const plan = planTemplates(existing, ids("rust", "linux"));
    expect(plan.entries.map((e) => [e.id, e.state])).toEqual([["rust", "present"], ["linux", "new"]]);
    expect(plan.blocks.map((b) => b.header)).toEqual([templateHeader("Linux")]);
    const covered = planTemplates(templateById("linux")!.lines.join("\n") + "\n", ids("linux"));
    expect(covered.entries[0].state).toBe("covered");
    expect(covered.blocks).toEqual([]);
    expect(covered.preview).toEqual([]);
  });

  it("gives an empty plan for no pick", () => {
    expect(planTemplates("a\n", new Set())).toEqual({ entries: [], blocks: [], groups: [], preview: [], warnings: [] });
  });

  it("separates the first block from the file with an empty line only when the file needs it", () => {
    expect(planTemplates("", ids("go")).preview[0]).toBe(templateHeader("Go"));
    expect(planTemplates("a\n", ids("go")).preview.slice(0, 2)).toEqual(["", templateHeader("Go")]);
    expect(planTemplates("a\n\n", ids("go")).preview[0]).toBe(templateHeader("Go"));
  });

  it("previews exactly what the backend writes", () => {
    const existing = "node_modules/\n*.log";
    const plan = planTemplates(existing, ids("java", "python", "node", "gradle", "jetbrains", "macos"));
    const written = appendIgnoreBlocks(existing, plan.blocks).text;
    expect(written).toBe(existing + "\n" + plan.preview.map((l) => l + "\n").join(""));
    // And a second run adds nothing.
    expect(appendIgnoreBlocks(written, plan.blocks).added).toEqual([]);
    expect(planTemplates(written, ids("java", "python", "node", "gradle", "jetbrains", "macos")).blocks).toEqual([]);
  });

  it("labels the add button and the toast", () => {
    expect(addLabel(planTemplates("", new Set()))).toBe("Add");
    expect(addLabel(planTemplates("", ids("rust")))).toBe("Add Rust");
    expect(addLabel(planTemplates("", ids("rust", "go")))).toBe("Add 2 templates");
    expect(addedTemplatesTitle([templateHeader("Rust")], ".gitignore")).toBe("Added the Rust template to .gitignore");
    expect(addedTemplatesTitle([templateHeader("Rust"), templateHeader("Go")], ".gitignore")).toBe("Added 2 templates to .gitignore");
  });
});

describe("the order of the templates in the file", () => {
  const text = (existing: string, ...picked: string[]) => appendIgnoreBlocks(existing, planTemplates(existing, ids(...picked)).blocks, TEMPLATE_ORDER).text;

  it("puts a template that is added later before the block of a template that comes after it", () => {
    const withGradle = text("", "gradle");
    const both = text(withGradle, "java");
    expect(both.indexOf(templateHeader("Java"))).toBeLessThan(both.indexOf(templateHeader("Gradle")));
    // The wrapper jar stays: the negation is under `*.jar`.
    const rules = ignore().add(both);
    expect(rules.ignores("gradle/wrapper/gradle-wrapper.jar")).toBe(false);
    expect(rules.ignores("libs/other.jar")).toBe(true);
  });

  it("gives the same file whether the templates come in one call or one by one", () => {
    const all = text("mine/\n", "linux", "java", "gradle", "vscode", "rust");
    let step = "mine/\n";
    for (const id of ["linux", "gradle", "vscode", "rust", "java"]) step = text(step, id);
    // The text differs in nothing but the lines that a pattern held by an earlier block would drop: compare the blocks in order.
    const headers = (t: string) => t.split("\n").filter((l) => l.startsWith("# --- DeepGit template:"));
    expect(headers(step)).toEqual(headers(all));
    expect(headers(all)).toEqual(["Java", "Rust", "Gradle", "Visual Studio Code", "Linux"].map(templateHeader));
    for (const t of [all, step]) expect(ignore().add(t).ignores("gradle/wrapper/gradle-wrapper.jar")).toBe(false);
  });

  it("previews exactly what is written, also inside the file", () => {
    const existing = `mine/\n\n${templateHeader("Gradle")}\n*.jar\n!gradle-wrapper.jar\n`;
    const plan = planTemplates(existing, ids("java", "rust", "windows"));
    // Java and Rust come before Gradle, Windows after it: at the end.
    expect(plan.groups.map((g) => g.before)).toEqual([templateHeader("Gradle"), null]);
    const [above, end] = plan.groups;
    expect(above.lines[0]).toBe(templateHeader("Java"));
    expect(above.lines).toContain(templateHeader("Rust"));
    expect(above.lines.indexOf(templateHeader("Rust"))).toBeGreaterThan(above.lines.indexOf(templateHeader("Java")));
    expect(end.lines).toEqual(["", templateHeader("Windows"), ...planTemplates(existing, ids("windows")).entries[0].lines]);
    expect(plan.preview).toEqual([...above.lines, ...end.lines]);
    // The file: its first lines as they were, the group above, an empty line, the old Gradle block, the group at the end.
    const written = appendIgnoreBlocks(existing, plan.blocks, TEMPLATE_ORDER).text;
    const head = "mine/\n\n";
    const gradle = existing.slice(head.length);
    expect(written).toBe(head + above.lines.map((l) => l + "\n").join("") + "\n" + gradle + end.lines.map((l) => l + "\n").join(""));
  });

  it("keeps CRLF when it goes inside the file", () => {
    const existing = `a\r\n${templateHeader("Linux")}\r\n*~\r\n`;
    const written = text(existing, "java");
    expect(written).toBe(`a\r\n\r\n${templateHeader("Java")}\r\n${planTemplates(existing, ids("java")).groups[0].lines.slice(1).join("\r\n")}\r\n\r\n${templateHeader("Linux")}\r\n*~\r\n`);
  });

  it("warns when a new rule comes after a line of the user that keeps a file", () => {
    // No DeepGit block ahead: Java goes to the end, after the hand-written negation.
    const plan = planTemplates("*.log\n!gradle-wrapper.jar\n", ids("java"));
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("*.jar");
    expect(plan.warnings[0]).toContain("gradle-wrapper.jar");
    expect(plan.warnings[0]).toContain("!gradle-wrapper.jar");
    expect(plan.warnings[0]).toContain("Java");
  });

  it("does not warn when nothing is hidden again", () => {
    expect(planTemplates("!keep.txt\n", ids("java")).warnings).toEqual([]);
    expect(planTemplates("", ids("java", "gradle")).warnings).toEqual([]);
    // The block goes above the negation of a DeepGit block: no warning.
    expect(planTemplates(text("", "gradle"), ids("java")).warnings).toEqual([]);
    // A negation with a glob is not checked.
    expect(planTemplates("!*.jar\n", ids("java")).warnings).toEqual([]);
    // A negation below the place where the block goes is not overridden.
    expect(planTemplates(`${templateHeader("Linux")}\n*~\n!gradle-wrapper.jar\n`, ids("java")).warnings).toEqual([]);
  });

  it("plans a file that cannot be inserted into with every block at the end, like the backend", () => {
    const existing = `${templateHeader("Linux")}\n*~\n`;
    const plan = planTemplates(existing, ids("java"), false);
    expect(plan.groups.map((g) => g.before)).toEqual([null]);
    expect(planTemplates(existing, ids("java"), true).groups.map((g) => g.before)).toEqual([templateHeader("Linux")]);
    expect(appendIgnoreBlocks(existing, plan.blocks, TEMPLATE_ORDER, false).text).toBe(`${existing}\n${plan.groups[0].lines.slice(1).join("\n")}\n`);
  });

  it("finds a template whose header has a byte order mark before it", () => {
    const existing = `\ufeff${templateHeader("Rust")}\ntarget/\n`;
    expect(presentIds(existing)).toEqual(new Set(["rust"]));
    expect(planTemplates(existing, ids("rust")).entries[0].state).toBe("present");
    // Java comes before the Rust block, Linux after it.
    expect(planTemplates(existing, ids("java")).groups.map((g) => g.before)).toEqual([templateHeader("Rust")]);
    expect(planTemplates(existing, ids("linux")).groups.map((g) => g.before)).toEqual([null]);
  });
});
