# Agent Note: Published npm dependency catalog

Status: implemented

English | [中文](2026-09-12-published-npm-dependency-catalog.zh.md)

## Problem

The README runs `npx @deepseek-ai/dsh web`. Workspace package lists and the development lockfile cannot identify the packages npm resolves for that command: the published `latest` tag can differ from the source version, npm installs required peers, and package ranges can resolve independently of the CLI version.

## Decision

The [dependency catalog](../../../../docs/dependency-catalog.md) records the published CLI's complete npm dependency resolution. Its [generator](../../../../scripts/gen-dependency-catalog.ts) asks npm to resolve only `@deepseek-ai/dsh@latest` in a temporary consumer with install scripts disabled. The committed npm lockfile and resolver metadata retain the registry, capture time, tool versions, and host platform. Normal generation and `doc-sync` compare deterministic English, Chinese, and pairing-record output without network access.

The catalog retains nested versions and duplicate package locations, excludes development-only entries, and distinguishes direct dependencies, transitive dependencies, automatically installed peers, and optional candidates. Package platform declarations remain visible. Optional installation failures, optional ancestor paths, install-script downloads, npm configuration, and an existing local installation or cache prevent a static record from promising an identical installation on every host.

The [third-party notices decision](2026-07-30-generated-third-party-notices.md) remains active: notices disclose licenses across distributed plugins and browser bundles, while this catalog records packages in the default npm installation. Neither inventory replaces the other.

## Alternatives considered

**Traverse workspace manifests or the pnpm lockfile.** Those describe source development and may include unpublished packages, build dependencies, and resolutions that npm does not choose.

**Resolve the live registry during each documentation check.** Registry changes would fail unrelated pull requests and make identical commits produce different documentation. An explicit refresh replaces the recorded resolution; ordinary checks remain offline.

**List every resolved entry as unconditionally installed.** npm records optional packages for multiple platforms, and optional installation can fail. The catalog identifies these candidates and states the limits of its lockfile-only evidence.

## Consequences

Readers can inspect exact resolved versions for the latest recorded public release, and contributors can refresh the record with one command. The capture time exposes when that evidence was gathered; the freshness check proves agreement with the committed resolution, not that npm's `latest` tag has remained unchanged. Focused tests cover runtime selection, nested versions, aliases, peers, optional platform entries, and stale generated files or translations.
