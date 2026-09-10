# Agent Note: Bundle the Desktop runtime and retain external plugins

Status: implemented

English | [中文](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)

Profile mutation and recovery follow the [in-place profile decision](2026-09-09-desktop-in-place-profile.md).

## Problem

Installing the core dependency graph during Desktop initialization repeats work already done by the release builder. An offline store eliminates downloads but retains extraction, package-manager startup, and installation costs. Users need the application to start with its production packages present while retaining ordinary npm plugin installation and plugin state across application upgrades.

Separate package directories can load duplicate Cordis or service modules. Retaining plugin files also does not prove compatibility with a new host API or Node runtime.

## Decision

[Runtime preparation](../../../../apps/desktop/scripts/prepare-dsh.ts) materializes the production graph once at build time and ships it through `extraResources/dsh`. The Electron shell stays in ASAR. A bundled upstream Node process runs the private Desktop Host from resources and loads enabled plugins from `$DSH_HOME/profiles/desktop`.

This note owns core resource storage and external plugin dependencies. The [packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md) retains release identity, signing, process ownership, and Electron-only plugin authorization. The [thin-wrapper decision](2026-09-10-desktop-web-wrapper.md) owns shared Web boot and HTTP transport.

## Package ownership

The resource descriptor records the exact release, Node version, platform, architecture, shared package versions, and final file hashes. The runtime tree contains ordinary files and directories, without links back to pnpm’s build store. Native Mach-O files are signed before hashing; the application signer preserves their bytes and checks the inventory after signing. An explicit `dsh/node_modules` resource mapping bypasses electron-builder’s root `node_modules` exclusion, and the copied tree is verified before any signing or notarization.

The [Desktop file policy](../../../../apps/desktop/scripts/runtime-file-policy.ts) applies after production npm installation and before native signing or descriptor generation. npm publication lists serve library consumers and can include declarations, maps, tests, and native build inputs; they do not identify the files needed by the Desktop process. The Desktop copy omits declarations and recognized source maps because Host execution uses JavaScript and generated Typert artifacts, inherits the user environment. Reviewed plugin lifecycle builds cover native dependencies, not arbitrary TypeScript compilation. Published npm packages and external plugin directories retain their own files. Source debugger navigation is a development-package capability.

Package-specific exclusions remove Domino tests, fs-ext compilation outputs, Koffi's Windows import library, and non-target node-pty prebuilds and debug symbols. The policy retains native executable dependencies, node-pty's ConPTY source distribution, licenses, and unrecognized assets; broad `src`, `test`, `.ts`, or `.map` exclusions could remove executable code or runtime data. Copy tests preserve sentinel assets and seal the filtered inventory; the bundled-Node [payload smoke](../../../../apps/desktop/tests/fixtures/runtime-payload-smoke.mjs) verifies PTY output, native file seeking, FFI, image conversion, and HTML parsing. Runtime preparation still verifies every retained byte and boots the complete Host with an external plugin.

Every first-party package in the dsh and private Host production closures is shared. The profile supplies missing packages through directory symlinks to those resources, or junctions on Windows; pnpm-installed packages take precedence. Links resolve to real host package directories under normal Node resolution. Host and plugin imports that resolve through these links share the same module instance for each resolved export. Distinct ESM and CommonJS conditional exports remain distinct entry points; a link cannot merge a package’s dual implementations.

External plugins use normal Node package resolution. Desktop does not recursively check peer versions, duplicate packages, linked packages, or ancestor dependency resolution. These checks duplicate package-manager and loader responsibilities and reject pnpm-supported installation sources. Shared host links remain available, but a plugin can resolve another installed copy; incompatible plugins may fail during Host startup and require recovery through the independent shell UI. A third-party package requiring host-wide instance identity must be explicitly added to the runtime’s shared inventory; matching version numbers alone are insufficient.

The profile manifest records pnpm-installed dependencies separately from its enabled bundle list. Disabling a plugin preserves its package, lockfile entry, and user configuration. The shared links are Desktop-owned derived state, recorded separately from pnpm; package-manager operations run without those links, then Desktop recreates them.

## Transactions and upgrades

First launch creates profile metadata and host links without running pnpm, preserving unrelated files. Compatible release changes or application relocation refresh links in place. Node version, platform, or architecture changes preserve installed plugins; pnpm and the loader report installation and compatibility failures.

Native canonical paths identify shared package directories. Windows launchers can vary path casing without moving the application; string equality would trigger unnecessary profile preparation. Profile cleanup explicitly unlinks every nested directory link before removing real directories. A Windows fixture under Electron 44 reproduces recursive `fs.rmSync` deleting files through a nested junction, while bundled upstream Node 24.17 preserves them. Cleanup qualification therefore includes the real Electron runtime; Node-only tests do not establish target preservation.

Dependency mutations use ordinary pnpm add and remove commands, including their configured lifecycle scripts. Installation sources and dependency resolution belong to pnpm. Bundle declarations select automatic activation; patch validation belongs to the bundle loader. Plain dependencies remain installed without activation. The bundled pnpm reads normal user and profile settings, including registry and build permissions. Desktop supplies no runtime build allowlist, strict-build setting, version-range restriction, or fixed profile identity. Unreadable package metadata does not prevent listing, disabling, or removing a dependency. Development uses the same manager against a separate plugin profile, with workspace packages supplied by the development runtime.

Desktop stops the Host before package mutations and waits for pnpm exit before restarting it. The [in-place decision](2026-09-09-desktop-in-place-profile.md) owns partial failures and explicit recovery. Recorded host links identify owned directories independently of package-operation completion.

The [immediate-window decision](2026-09-09-desktop-immediate-window-and-direct-start.md) owns direct Host startup and recovery in the main window. Users can update, remove, disable, or re-enable plugins and retry startup. Incompatible plugins are not silently deleted or automatically downgraded.

## Alternatives considered

Full runtime verification belongs to packaging. Startup reads the descriptor, checks shared package records and required Host entries, and uses the recorded runtime identity for profile reuse. The [release-validation decision](2026-09-09-desktop-build-release-validation.md) assigns release and target compatibility checks to packaging. It neither enumerates nor hashes installed runtime files, including on first launch or after an upgrade. Reading every file before backend loading adds startup I/O proportional to the distribution size. Installed content changes therefore are not detected by a startup checksum comparison; unusable modules fail when loaded. Build-time verification still rejects changed, missing, extra, or linked files against the recorded inventory.

- **Install the bundled offline seed at startup.** This preserves an ordinary pnpm installation procedure but repeats core extraction and installation on every affected machine. Materialized resources remove that work at the cost of more application files and release-builder responsibility.
- **Link all host dependencies into plugins.** This unnecessarily couples ordinary plugin dependencies to the host. Only the explicit shared inventory is linked; private packages retain independent versions.
- **Use hardlinks.** They cannot represent directories, may not cross volumes, share writable bytes, and retain old inodes after application replacement. Directory symlinks and Windows junctions express the intended package target.
- **Use `NODE_PATH` or preserve symlink paths.** These do not provide uniform ESM resolution or shared module identity. Normal package lookup through explicit links is directly testable.
- **Keep core packages in ASAR.** The backend uses upstream Node rather than Electron’s patched filesystem. Ordinary `extraResources` also preserves native loading and subprocess paths.

## Consequences

Core package installation is absent from first launch and compatible upgrades. Metadata checks and backend loading still cost startup time; no release latency or download-size improvement is claimed without measurement. Plugin preservation is conditional on host API and native runtime compatibility, with a visible recovery path when that condition fails.

The [Desktop README](../../../../apps/desktop/README.md) owns operational guidance. Focused tests cover real pnpm installation and approved builds, shared ESM instance identity, private dependency versions, relocation, disabled plugins, runtime changes without automatic reinstalls, activation failures, and transaction locking. Signed installed-artifact upgrades, macOS notarization, Windows junction/native behavior, release size and startup benchmarks, and real-model GUI recordings remain release-environment qualification requirements; unit fixtures do not substitute for them.
