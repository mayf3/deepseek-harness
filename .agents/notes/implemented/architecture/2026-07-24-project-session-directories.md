# Agent Note: Project-grouped session directories

Status: implemented

English | [中文](2026-07-24-project-session-directories.zh.md)

## Problem

A persistence root may be local to one project, shared by several projects, temporary, or centralized. The hashed cwd buckets kept all deployments functional but made a shared root difficult to navigate because a developer could not recognize a project from its directory name.

Each JSONL session also occupied one file directly inside the project bucket. That shape had no ownership directory for additional session artifacts such as metadata, attachments, spill files, or coordination state.

## Decision

The JSONL backend stores sessions under a readable project key and gives every session its own directory:

```text
<configured-root>/
  --<normalized-cwd>--/
    <encoded-session-id>/
      session.jsonl.zstd
      session.v1.jsonl.zstd
```

The two files illustrate retained v0 plus current v1; raw mode omits `.zstd`, positive versions use lowercase `.vN`, and Sessions without a cwd use `_no-cwd`. Filesystem and drive separators become `-`, unsafe code units use `~XXXX`, and the readable name is bounded to keep the component within filesystem limits.

The project key intentionally has no hash suffix. This follows the common human-readable convention used by coding agents and keeps the normalized project path as the complete directory name. The normalization is lossy: paths such as `/a/b-c` and `/a-b/c`, or long paths with the same retained prefix, share one project directory. Their distinct session ids still select separate session directories; reuse of the same session id remains a storage collision and is rejected.

Case-insensitive filesystems can also make differently cased project keys refer to one physical directory. Identity validation accepts such an alternate spelling only when filesystem canonicalization resolves the discovered and expected paths to the same transcript. A different canonical path remains corruption, so case aliases do not weaken the same-id collision check on case-sensitive stores.

The configured root remains a deployment choice. The layout neither selects a global root nor requires projects to share one. When a deployment does centralize storage, project paths remain recognizable; a project-local root uses the same deterministic structure.

The encoded Session id names an ownership directory rather than one transcript. `SessionPersistence.locate(meta)` returns the canonical target for `meta.version`; header-only discovery scans canonical generation names and selects the numerically highest one, while ignoring unrelated entries. The directory can therefore retain prior generations and add other Session-owned artifacts without another layout change.

Lazy materialization remains tied to the current generation: `create()` performs no filesystem I/O, and the first append creates the project/Session directories before no-overwrite publication at the current version's canonical name. Empty directories are not listed as Sessions. The backend rejects flat `<project>/<id>.jsonl*` artifacts with an explicit layout error; it provides no automatic migration from that obsolete directory layout.

## Alternatives considered

**Keep opaque cwd hashes.** This preserved short names but defeated the requested navigation by project path when several projects share a persistence root.

**Put session files directly in each project directory.** This matched Claude Code and pi's basic file organization but left no session-level ownership boundary for future artifacts.

**Add a collision-resistant hash suffix.** This distinguishes paths whose normalized forms collide, but makes the directory name more than the normalized project path. The chosen convention accepts lossy project grouping in exchange for the simpler, recognizable name.

**Mandate a centralized root.** Rejected because storage placement belongs to deployment configuration. Project grouping is useful when roots are shared and harmless when they are not.

**Load both flat and directory layouts.** Rejected under the pre-release no-compatibility stance. One accepted layout keeps identity checks and discovery deterministic.

## Consequences

Shared stores can be navigated by recognizable project names, while local and custom roots keep their existing configuration freedom. Every Session has a directory for immutable generation names and other future backend-owned artifacts; callers receive either a version-qualified `locate` target or the exact highest path discovered by listing.

Project directory names are longer than the former 12-hex cwd hashes. Very long paths show only a bounded prefix. Moving a project usually selects a different directory, but distinct cwd strings that normalize to the same name share one project directory by design.
