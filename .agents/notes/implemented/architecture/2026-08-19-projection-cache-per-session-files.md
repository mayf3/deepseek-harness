# Agent Note: Projection cache as per-session files

Status: implemented

English | [中文](2026-08-19-projection-cache-per-session-files.zh.md)

## Problem

The persisted projection cache was one global `session_projcache.json` — a `sessions` table in a single file at the storage root. Every throttled checkpoint rewrote the whole file containing every session's rows, so write amplification grew with session count, and one malformed file took the entire cache down at once.

## Decision

The cache becomes one `projection_cache.json` per session, stored under the cache's own storage root — `<root>/<session-id>/projection_cache.json` (the session id is a code-generated string, used directly as the directory name). The cache owns its directory tree and never consults the persistence layer: no `locate`, no dependency on which backend is mounted. The cache service keeps every other responsibility: checkpoint fold, write policy (turn/end + disposal mandatory, count/interval throttle), fail-soft durability, and the listing read.

Reading a cache row is one file read, so `cachedSnapshot(meta)` is async. The cache no longer runs a cold-refold ladder (that would require reading the session log, which belongs to the persistence layer); a consumer that needs a guaranteed cold snapshot refolds from the log itself. Session directories and cache files are created owner-only (`0o700`/`0o600`) via `@deepseek-ai/dsh-atomic-write`.

## Consequences

- Per-session write isolation: each throttled write replaces only that session's small file, removing the global write amplification. Writes to one cache file serialize, so a newer cut never lands before an older one; plugin disposal drains in-flight writes.
- Listing pays N small file reads instead of one big load; a session without a cache file simply lacks the projection column.
- No migration: the cache is derived data, never an authority. An obsolete cache (any earlier format) is never read — the first cold read refolds from the log and writes the current format.
- The cache file is bound to the same log lifecycle as before: the stored `{createdAt, cwd}` identity guards against a recreated id.

## Alternatives considered

- **Keep the global sessions table.** Preserves one-load listing, but keeps the global write amplification and single-file blast radius that motivated the change.
- **Resolve the path through `sessionPersistence.locate(meta)`** (the file beside the session log). Rejected: the cache would have to guess "beside the log" from a log artifact path (`dirname` + fixed filename), coupling the cache to the persistence service and to a backend's layout. The cache keeps its own tree instead.
- **Replicate the session-directory layout inside the cache.** Rejected: the persistence backend already owns that layout; the cache does not need the log's project/session directory structure for its own derived files.
- **Use the existing `@deepseek-ai/dsh-atomic-write`.** Adopted: it is the repo's single atomic whole-file write primitive (owner-only modes included); exporting a second one from the storage-json backend was rejected.
