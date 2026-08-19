# Agent Note: Projection cache as per-session files

Status: implemented

English | [中文](2026-08-19-projection-cache-per-session-files.zh.md)

## Problem

The persisted projection cache was one global `session_projcache.json` — a `sessions` table in a single file at the storage root. Every throttled checkpoint rewrote the whole file containing every session's rows, so write amplification grew with session count, and one malformed file took the entire cache down at once.

## Decision

The cache becomes one `projection_cache.json` per session, stored inside the session's own persistence directory. The location comes from the persistence seam — `sessionPersistence.locate(meta)` — so the persistence backend owns the session-directory layout (the jsonl backend places the file beside the session log); the cache service never imports a backend's path helpers. The cache service keeps every other responsibility: checkpoint fold, write policy (turn/end + disposal mandatory, count/interval throttle), fail-soft durability, and the cold-read ladder.

Reading a cache row is now one file read, so `cachedSnapshot(meta)` is async; `coldSnapshot` takes the session header (it needs the header to locate the file — the stored log's header remains the identity witness). A persistence backend without a per-session directory (e.g. sqlite) disables the durable cache: writes no-op and cold reads fall to the full-log rung.

## Consequences

- Per-session write isolation: each throttled write replaces only that session's small file, removing the global write amplification.
- Listing pays N small file reads instead of one big load; a session without a cache file simply lacks the projection column.
- No migration: the cache is derived data, never an authority. An obsolete global cache (or any earlier format) is never read — the first cold read refolds from the log and writes the current format.
- The cache file is bound to the same log lifecycle as before: the stored `{createdAt, cwd}` identity guards against a recreated id or a swapped store.

## Alternatives considered

- **Keep the global sessions table.** Preserves one-load listing and a synchronous `cachedSnapshot`, but keeps the global write amplification and single-file blast radius that motivated the change.
- **One storage-domain unit per session in the storage root** (flat `session_projcache_<id>.json`). Rejected: unit names must match `[a-z0-9_]` (session ids cannot), and the files would sit outside the session's own directory, scattering the storage root instead of living beside the log.
- **Replicate the session-directory layout inside the cache.** Rejected: the persistence backend already owns that layout through `locate`; duplicating the path helpers couples the cache to a backend's internals.
