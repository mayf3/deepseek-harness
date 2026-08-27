# Agent Note: Inspector development mount

Status: implemented

English | [中文](2026-08-27-inspector-development-mount.zh.md)

## Problem

`@deepseek-ai/dsh-experimental-inspector` is a private package no published dsh installation carries, yet development launches need to mount it into the shipped Web composition on demand. A row in a shipped bundle patch cannot express this: `verify-cordis-config` requires every named row of a bundle patch to resolve from that bundle's own `dependencies` — disabled rows included — and a published manifest must not depend on an unpublished package.

## Decision

The inspector package owns a development overlay, `packages/experimental/inspector/cordis.patch.yml`, holding a single `insert` of the `experimental-inspector` row. A launch selects it through the generic overlay flag; `pnpm run demo:inspector` is the shorthand for `pnpm dsh web --patch ./packages/experimental/inspector/cordis.patch.yml`.

The overlay contributes only the row; the row's module resolves from the profile plane at entry import:

- A source launch (`pnpm dsh`, tsx) resolves the workspace package through the tsconfig `paths` facade and needs no installation.
- A built launch (`node apps/cli/lib/bin.js`) needs the package importable from the profile first: `dsh plugin --profile web add link:<absolute package path>`, once per profile. `link:` keeps dependency resolution inside the real package directory; `file:` re-installs the package's `workspace:^` dependencies in the profile and fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`.

A launch whose profile cannot import the package fails loud at entry import (`Cannot find package '@deepseek-ai/dsh-experimental-inspector' imported from <profile dir>`); nothing is skipped silently.

## Consequences

Published packages carry no trace of the inspector: no manifest entry, no composition row, no launcher flag. Mounting stays a per-launch choice — the same service without the overlay never loads the package — and every layer the launch composes is declared in a config file. The cost is launch-mode asymmetry: a built launch needs the one-time profile `link:` install, and the overlay must be named on every invocation, which `pnpm run demo:inspector` absorbs for the common case.

## Alternatives considered

- A `disabled: !!js` row in the shipped web-app patch: the dependency gate and npm publication both force the private package into the published manifest.
- A `--inspector` launcher flag mounting the package as an extra bundle layer: the launcher owns neither app flags nor plugin package names.
- An optional `peerDependencies` entry on `dsh-web-app` plus a dynamic `ctx.loader.create` from its glue plugin: it writes a never-published name into a published manifest and mounts a row no config layer declares.
