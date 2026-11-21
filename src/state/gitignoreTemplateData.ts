/**
 * The data of the gitignore templates (`state/gitignoreTemplates.ts` holds the rules that use it). Each template is a trimmed
 * version of the one in github.com/github/gitignore (CC0 1.0): the usual files of the language, tool or system, with a short
 * comment above each group. `rules` is read with `String.raw`, so a backslash stays as it is.
 *
 * The order matters. It is the order of the dialog, and the order of the blocks in the file. A language comes before its
 * build tool: `Gradle` re-includes `gradle-wrapper.jar` (`!gradle-wrapper.jar`) after `Java` ignored every `*.jar`.
 */

export type TemplateGroup = "languages" | "build" | "ides" | "os";

export interface TemplateDef {
  /** Stable key (never shown). */
  id: string;
  /** The name in the dialog and in the header line of the block. */
  name: string;
  group: TemplateGroup;
  /** What the template covers, in a few words. */
  summary: string;
  /** Patterns and comments. Empty lines separate the groups. */
  rules: string;
}

export const TEMPLATE_GROUPS: readonly { id: TemplateGroup; label: string }[] = [
  { id: "languages", label: "Languages and frameworks" },
  { id: "build", label: "Build tools" },
  { id: "ides", label: "IDEs and editors" },
  { id: "os", label: "Operating systems" },
];

export const TEMPLATE_DEFS: readonly TemplateDef[] = [
  // ------------------------------------------------------------------ languages and frameworks
  {
    id: "java",
    name: "Java",
    group: "languages",
    summary: "Class files, jars and wars, JVM crash logs",
    rules: String.raw`
# Compiled classes
*.class

# Packages and archives
*.jar
*.war
*.ear
*.nar
*.zip
*.tar.gz
*.rar

# JVM crash and replay logs
hs_err_pid*
replay_pid*

# Logs
*.log

# BlueJ and J2ME
*.ctxt
.mtj.tmp/
`,
  },
  {
    id: "kotlin",
    name: "Kotlin",
    group: "languages",
    summary: "Kotlin Gradle plugin data, class files, jars",
    rules: String.raw`
# Kotlin Gradle plugin data
.kotlin/

# Compiled classes
*.class

# Packages and archives
*.jar
*.war
*.ear
*.nar
*.zip
*.tar.gz
*.rar

# JVM crash and replay logs
hs_err_pid*
replay_pid*

# Logs
*.log
`,
  },
  {
    id: "rust",
    name: "Rust",
    group: "languages",
    summary: "Cargo target folder, rustfmt backups",
    rules: String.raw`
# Cargo build output
target/

# rustfmt backups
**/*.rs.bk

# MSVC debug information
*.pdb

# cargo-mutants data
**/mutants.out*/

# Crash dumps of an internal compiler error
rustc-ice-*.txt
`,
  },
  {
    id: "c",
    name: "C",
    group: "languages",
    summary: "Object files, libraries, executables",
    rules: String.raw`
# Object files
*.o
*.obj
*.ko
*.elf

# Precompiled headers
*.gch
*.pch

# Static libraries
*.a
*.la
*.lo
*.lib

# Shared libraries
*.so
*.so.*
*.dylib
*.dll

# Executables
*.exe
*.out
*.app

# Dependency files and linker output
*.d
*.ilk
*.map
*.exp

# Debug information
*.dSYM/
*.dwo
*.pdb
*.idb
*.su
`,
  },
  {
    id: "cpp",
    name: "C++",
    group: "languages",
    summary: "Object files, libraries, executables, debug files",
    rules: String.raw`
# Object files
*.o
*.obj
*.slo
*.lo
*.ko
*.elf

# Precompiled headers
*.gch
*.pch

# Static libraries
*.a
*.la
*.lai
*.lib

# Shared libraries
*.so
*.so.*
*.dylib
*.dll

# Executables
*.exe
*.out
*.app

# Dependency files and linker output
*.d
*.ilk
*.map
*.exp

# Debug information
*.dSYM/
*.dwo
*.pdb
*.idb
*.su
`,
  },
  {
    id: "python",
    name: "Python",
    group: "languages",
    summary: "Bytecode, virtual environments, packaging, caches",
    rules: String.raw`
# Bytecode
__pycache__/
*.py[cod]
*$py.class

# C extensions
*.so

# Virtual environments and local settings
.venv/
venv/
env/
ENV/
.env
.envrc

# Packaging and distribution
build/
dist/
*.egg-info/
*.egg
.eggs/
wheels/
sdist/
MANIFEST
pip-log.txt
pip-delete-this-directory.txt

# Dependency tools
.pdm-python
.pdm-build/
.pixi/*
!.pixi/config.toml
__pypackages__/

# Tests and coverage
.pytest_cache/
.tox/
.nox/
.hypothesis/
.coverage
.coverage.*
htmlcov/
coverage.xml
*.cover
*.lcov
nosetests.xml

# Type checkers and linters
.mypy_cache/
.dmypy.json
dmypy.json
.pyre/
.pytype/
.ruff_cache/

# Notebooks
.ipynb_checkpoints

# Logs
*.log

# Django and Flask
local_settings.py
db.sqlite3
db.sqlite3-journal
instance/
.webassets-cache

# Documentation builds
docs/_build/

# Celery
celerybeat-schedule*
celerybeat.pid

# Cython
cython_debug/
`,
  },
  {
    id: "node",
    name: "Node.js",
    group: "languages",
    summary: "node_modules, build output, logs, caches, .env files",
    rules: String.raw`
# Dependencies
node_modules/
jspm_packages/
web_modules/

# Build output
dist/
build/Release
.next/
.nuxt/
.output/
.svelte-kit/
.astro/
.turbo/
.vite/
.docusaurus/

# Logs
logs/
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

# Environment files
.env
.env.*
!.env.example

# Caches
.cache/
.parcel-cache/
.eslintcache
.stylelintcache
*.tsbuildinfo
.npm
.node_repl_history

# Coverage
coverage/
.nyc_output/
*.lcov

# Packages and package manager data
*.tgz
.yarn-integrity
.pnpm-store/
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/sdks
!.yarn/versions

# Vite timestamps
vite.config.js.timestamp-*
vite.config.ts.timestamp-*

# VS Code extension tests
.vscode-test
`,
  },
  {
    id: "go",
    name: "Go",
    group: "languages",
    summary: "Binaries, test binaries, coverage output, go.work",
    rules: String.raw`
# Binaries and libraries
*.exe
*.exe~
*.dll
*.so
*.dylib

# Test binaries and output
*.test
*.out

# Coverage
coverage.html
coverage.txt
coverage.xml
*.coverprofile
profile.cov

# Workspace files
go.work
go.work.sum

# Environment file
.env
`,
  },
  {
    id: "dotnet",
    name: ".NET / Visual Studio",
    group: "languages",
    summary: "bin and obj folders, .vs, user files, NuGet packages",
    rules: String.raw`
# User-specific files
*.rsuser
*.suo
*.user
*.userosscache
*.userprefs
*.sln.docstates

# Visual Studio cache
.vs/

# Build results
[Dd]ebug/
[Dd]ebugPublic/
[Rr]elease/
[Rr]eleases/
x64/
x86/
[Aa][Rr][Mm]/
[Aa][Rr][Mm]64/
[Ww][Ii][Nn]32/
bld/
[Bb]in/
[Oo]bj/
[Ll]og/
[Ll]ogs/

# .NET Core and NuGet
project.lock.json
project.fragment.lock.json
artifacts/
*.nupkg
*.snupkg

# MSBuild logs
*.binlog
*.log
*.tlog

# Test and coverage results
[Tt]est[Rr]esult*/
*.trx
TestResult.xml
nunit-*.xml
*.VisualState.xml
coverage*.json
coverage*.xml
coverage*.info
*.coverage
*.coveragexml
BenchmarkDotNet.Artifacts/

# C++ build files of Visual Studio
*.obj
*.pch
*.pdb
*.ilk
*.idb
ipch/
*.aps
*.ncb
*.opendb
*.opensdf
*.sdf
*.VC.db
*.VC.VC.opendb

# ReSharper, Rider, TeamCity and dotCover
_ReSharper*/
*.[Rr]e[Ss]harper
*.DotSettings.user
_TeamCity*
*.dotCover

# Temporary files
~$*
*~
`,
  },
  {
    id: "unity",
    name: "Unity",
    group: "languages",
    summary: "Library, Temp, Logs, Builds, generated project files",
    rules: String.raw`
# Generated folders (at the root of the project)
/[Ll]ibrary/
/[Tt]emp/
/[Oo]bj/
/[Bb]uild/
/[Bb]uilds/
/[Ll]ogs/
/[Uu]ser[Ss]ettings/
/[Mm]emory[Cc]aptures/
/[Rr]ecordings/
/[Aa]ssets/[Ss]ceneDependencyCache*
/UIElementsSchema/
.utmp/

# IDE caches
.vs/
.gradle/
.consulo/
ExportedObj/

# Generated solution and project files
*.csproj
*.unityproj
*.sln
*.slnx
*.suo
*.tmp
*.user
*.userprefs
*.pidb
*.booproj
*.svd
*.pdb
*.mdb
*.opendb
*.VC.db
.vsconfig

# Rider plugin and settings
/[Aa]ssets/Plugins/Editor/JetBrains*
*.DotSettings.user

# Builds
*.apk
*.aab
*.obb
*.app
*.unitypackage
*.unitypackage.meta
/*_BackUpThisFolder_ButDontShipItWithYourGame/
/*_BurstDebugInformation_DoNotShip/

# Logs and crash files
*.log
sysinfo.txt
mono_crash.*
.dirstamp
tmpinst-dir.stamp

# Addressables
/[Aa]ssets/AddressableAssetsData/*/addressables_content_state.bin
/[Aa]ssets/AddressableAssetsData/*/addressables_content_state.bin.meta
/[Aa]ssets/AddressableAssetsData/link.xml
/[Aa]ssets/AddressableAssetsData/link.xml.meta
/[Aa]ssets/Addressables_Temp/
/[Aa]ssets/Addressables_Temp.meta
/[Aa]ssets/StreamingAssets/aa/
/[Aa]ssets/StreamingAssets/aa.meta
/ServerData/

# Crash recovery and generated files
/[Aa]ssets/_Recovery/
/[Aa]ssets/_Recovery.meta
/[Aa]ssets/GeneratedLocalRepo/
/[Aa]ssets/GeneratedLocalRepo.meta
crashlytics-build.properties
`,
  },

  // ------------------------------------------------------------------ build tools
  {
    id: "maven",
    name: "Maven",
    group: "build",
    summary: "target folder, release and versions backups",
    rules: String.raw`
# Build output
target/

# Release plugin
pom.xml.tag
pom.xml.releaseBackup
pom.xml.versionsBackup
pom.xml.next
release.properties
dependency-reduced-pom.xml
buildNumber.properties

# Timing and wrapper download
.mvn/timing.properties
.mvn/wrapper/maven-wrapper.jar
`,
  },
  {
    id: "gradle",
    name: "Gradle",
    group: "build",
    summary: ".gradle cache, build folders (the wrapper jar stays)",
    rules: String.raw`
# Cache of the project
.gradle/
.gradletasknamecache

# Build output (not a folder of sources named build)
**/build/
!**/src/**/build/

# Gradle GUI config
gradle-app.setting

# Keep the wrapper (jar files are ignored above)
!gradle-wrapper.jar
!gradle-wrapper.properties
`,
  },
  {
    id: "cmake",
    name: "CMake",
    group: "build",
    summary: "CMakeCache, CMakeFiles, generated build files",
    rules: String.raw`
# Build folders
build/
cmake-build-*/

# Generated by CMake
CMakeCache.txt
CMakeFiles
CMakeScripts
cmake_install.cmake
install_manifest.txt
CTestTestfile.cmake
Testing
_deps
Makefile
compile_commands.json

# User files
CMakeLists.txt.user
CMakeUserPresets.json
`,
  },

  // ------------------------------------------------------------------ IDEs and editors
  {
    id: "jetbrains",
    name: "JetBrains (IntelliJ)",
    group: "ides",
    summary: "IntelliJ IDEA, PyCharm, CLion, WebStorm, Rider: .idea state",
    rules: String.raw`
# User-specific files
.idea/**/workspace.xml
.idea/**/tasks.xml
.idea/**/usage.statistics.xml
.idea/**/dictionaries
.idea/**/shelf
.idea/**/aws.xml

# Generated files
.idea/**/contentModel.xml

# Sensitive or high-churn files
.idea/**/dataSources/
.idea/**/dataSources.ids
.idea/**/dataSources.local.xml
.idea/**/sqlDataSources.xml
.idea/**/dynamic.xml
.idea/**/uiDesigner.xml
.idea/**/dbnavigator.xml
.idea/**/mongoSettings.xml

# Gradle
.idea/**/gradle.xml
.idea/**/libraries

# File-based project format
*.iws

# Build output
out/
cmake-build-*/

# Plugins
.idea_modules/
atlassian-ide-plugin.xml
.idea/replstate.xml
.idea/sonarlint/
.idea/sonarlint.xml
.idea/httpRequests
http-client.private.env.json
.idea/kubernetes/configs/kubeconfig_*
com_crashlytics_export_strings.xml
crashlytics.properties
crashlytics-build.properties
fabric.properties

# Android Studio cache
.idea/caches/build_file_checksums.ser
`,
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    group: "ides",
    summary: ".vscode folder (settings, tasks and launch files stay)",
    rules: String.raw`
# Workspace folder: keep the files that a team shares
.vscode/*
!.vscode/settings.json
!.vscode/tasks.json
!.vscode/launch.json
!.vscode/extensions.json
!.vscode/*.code-snippets
!*.code-workspace

# Local History extension
.history/

# Built extensions
*.vsix
`,
  },

  // ------------------------------------------------------------------ operating systems
  {
    id: "macos",
    name: "macOS",
    group: "os",
    summary: ".DS_Store, resource forks, Spotlight and Trash folders",
    rules: String.raw`
# Finder
.DS_Store
.localized
.LSOverride
.AppleDouble
__MACOSX/
Icon[[:cntrl:]]

# Resource forks
._*

# Folders that appear at the root of a volume
.DocumentRevisions-V100
.fseventsd
.Spotlight-V100
.TemporaryItems
.Trashes
.VolumeIcon.icns
.com.apple.timemachine.donotpresent
.PKInstallSandboxManager
.PKInstallSandboxManager-SystemSoftware

# Folders on a remote AFP share
.AppleDB
.AppleDesktop
Network Trash Folder
Temporary Items
.apdisk
`,
  },
  {
    id: "windows",
    name: "Windows",
    group: "os",
    summary: "Thumbs.db, desktop.ini, shortcuts, Recycle Bin",
    rules: String.raw`
# Thumbnail caches
Thumbs.db
Thumbs.db:encryptable
ehthumbs.db
ehthumbs_vista.db

# Dump files
*.stackdump

# Folder settings
[Dd]esktop.ini

# Recycle Bin on file shares
$RECYCLE.BIN/

# Installer files
*.cab
*.msi
*.msix
*.msm
*.msp

# Shortcuts
*.lnk
`,
  },
  {
    id: "linux",
    name: "Linux",
    group: "os",
    summary: "Editor backups (*~), .directory, .Trash-*, .nfs*",
    rules: String.raw`
# Editor backups
*~

# Left by a process that still holds a deleted file
.fuse_hidden*
.nfs*

# KDE Dolphin folder settings
.directory

# Trash folders on other disks
.Trash-*

# Output of nohup
nohup.out
`,
  },
];
