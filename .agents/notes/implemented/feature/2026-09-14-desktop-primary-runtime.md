# Agent Note: Desktop primary runtime

Status: implemented

English | [中文](2026-09-14-desktop-primary-runtime.zh.md)

## Problem

Desktop agents need predictable Python data-processing libraries and an independent Node interpreter on machines without development environments. System interpreter selection must remain under user control.

## Decision

Desktop ships Python, Node.js, pnpm, numpy and pandas as one release-bound payload. The path-query tool installs the payload from application resources into the fixed Harness-home directory and returns absolute paths. It does not change PATH, environment variables or package-manager configuration. pnpm uses its native global-install rules.

The application version and component versions live in `runtime.json`, not the directory name. Installation publishes a completed staged copy and retains the previous directory until replacement succeeds. Matching releases reuse installed files; upgrades replace user-added Python dependencies inside the managed tree. The Desktop single-instance owner and the tool's shared installation promise serialize normal installation requests.

Node downloads and hash-verifies the complete locked wheel set and unpacks these library-only archives into site-packages. This avoids build-host Python and pip version selection without implementing dependency resolution or general wheel installation. Wheels with `.data` installation directories are rejected; command-line entry-point wrappers are outside this library payload. Native smoke executes the final payload after temporary files are removed, so interpreter links must survive relocation.

macOS grants `com.apple.security.cs.allow-jit` only to the standalone Node executable. Hardened-runtime signing without that entitlement prevents V8 from allocating its code region. Interpreter and library smoke checks run after signing as well as after staging cleanup; a valid signature alone does not establish executable behavior.

Windows signed packaging separates materialization from execution with a supervised primary-runtime signing stage. PE inspection excludes foreign-platform Node addons and refuses directory links. Valid vendor signatures remain intact; only unsigned files receive the configured EV signature. Invalid existing signatures fail before hardware access, and each new signature is checked for validity, timestamp and certificate identity before the next file. Electron-builder's copy-time signing hook preserves runtime executables only after exact-byte and signature verification; the same serial queue rejects later tasks if preservation fails. The existing per-user interlock, serialized signer and redacted journal own hardware calls; no failure permits a retry or later stage. Runtime execution receives no signing credentials and follows complete verification. Development and unsigned preparation retain native smoke without automatic hardware access.

Desktop ZIP extraction pins `extract-zip` to `yauzl` 3.4.0 through a scoped dependency override. The 2.x reader can leave large deflate entries unfinished on Node 26 ([upstream issue](https://github.com/thejoshwolfe/yauzl/issues/176)); retaining the existing extractor preserves its path validation and wheel-entry checks. The development launcher uses top-level await so unfinished preparation cannot exit successfully. A large compressed wheel regression checks the complete extracted bytes.

## Alternatives considered

**System interpreters only.** They do not provide predictable availability or preinstalled numpy and pandas.

**PATH injection and dedicated pnpm global directories.** They change command selection or require pnpm's global command directory to be on PATH. Absolute interpreter paths and native pnpm behavior satisfy the requested scope without those changes.

**Independent updates and version-named directories.** Runtime releases are coupled to Desktop, and the requested installation location is stable.

**Signing only the interpreter or bypassing native smoke.** Windows code integrity also evaluates DLLs and Python extensions. A signed launcher cannot make an unsigned extension load, and skipping execution would hide unusable installed dependencies. Preserving valid upstream signatures avoids unnecessary hardware operations and retains upstream attribution.

## Consequences

The application carries additional native files and replaces the complete managed payload on upgrade. Running interpreters can prevent replacement on Windows. Native build smoke, install/reuse/recovery tests and a keyless tool-error session cover distinct installation and model-output paths; macOS signing uses the existing native-runtime signer. Interpreter archives and Python wheels are hash-pinned, and licenses remain with their distributions.
