# Agent Note: Desktop primary runtime

Status: implemented

English | [中文](2026-09-14-desktop-primary-runtime.zh.md)

## Problem

Desktop agents need predictable Python data-processing libraries and an independent Node interpreter on machines without development environments. System interpreter selection must remain under user control.

## Decision

Desktop ships Python, Node.js, pnpm, numpy and pandas as one release-bound payload. The path-query tool installs the payload from application resources into the fixed Harness-home directory and returns absolute paths. It does not change PATH, environment variables or package-manager configuration. pnpm uses its native global-install rules.

The application version and component versions live in `runtime.json`, not the directory name. Installation publishes a completed staged copy and retains the previous directory until replacement succeeds. Matching releases reuse installed files; upgrades replace user-added Python dependencies inside the managed tree. The Desktop single-instance owner and the tool's shared installation promise serialize normal installation requests.

## Alternatives considered

**System interpreters only.** They do not provide predictable availability or preinstalled numpy and pandas.

**PATH injection and dedicated pnpm global directories.** They change command selection or require pnpm's global command directory to be on PATH. Absolute interpreter paths and native pnpm behavior satisfy the requested scope without those changes.

**Independent updates and version-named directories.** Runtime releases are coupled to Desktop, and the requested installation location is stable.

## Consequences

The application carries additional native files and replaces the complete managed payload on upgrade. Running interpreters can prevent replacement on Windows. Native build smoke, install/reuse/recovery tests and a keyless tool-error session cover distinct installation and model-output paths; macOS signing uses the existing native-runtime signer. Interpreter archives and Python wheels are hash-pinned, and licenses remain with their distributions.
