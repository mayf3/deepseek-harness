# Agent Note: One-shot startup cleanup for local spill files

Status: implemented

English | [中文](2026-07-17-local-spill-startup-cleanup.zh.md)

## Problem

The local spill backend never deleted the full tool results it wrote. Every oversized result added another file, so configured roots grew without bound and default per-process `dsh-spill-*` roots accumulated across runs. Immediate deletion is wrong because persisted, resumed, and forked sessions may still reference a locator. The [tool output spill policy](./2026-07-08-tool-output-spill-files.md) needs a bounded local-storage lifetime.

## Decision

`dsh-spill-local` runs one best-effort cleanup sweep after activation. It does not delay service availability, is owned by the plugin fiber (a single `ctx.effect` whose generator launches the sweep and yields an async disposer that awaits it), and is awaited during disposal so no sweep I/O outlives the fiber. There is no recurring timer and no separate process.

A `cleanupPeriodDays` config defaults to `30`; `0` disables cleanup. An invalid value (negative or fractional) throws at load. The sweep scans the configured/active root plus any prior default `dsh-spill-*` temp roots discovered under the OS temp dir and deletes regular files whose `mtime` is strictly older than `now − cleanupPeriodDays`. It prunes empty session directories and roots only for discovered prior-default roots; the active root keeps its session directories so pruning cannot race a local write, while writes recreate a session directory if another process prunes a discovered root that is still active. It uses `lstat`, so a symlink is never followed or deleted; unrelated entries (non-`session-` directories, special files) are skipped. Every filesystem failure is caught and logged through `ctx.logger.warn`, and a warning-sink exception is also contained — the sweep never throws, so it cannot reject activation or a concurrent spill write. Discovery excludes symlinks and non-directories, returning only real `dsh-spill-*` directories the backend could have created.

The ctx-free sweep mechanics live in `packages/spill/spill-local/src/cleanup.ts` (`sweepSpillRoots`, `discoverDefaultRoots`), unit-testable without a `ctx`; `store.ts` owns root naming, path derivation, and writes, while the service in `src/index.ts` owns the config, cutoff, and fiber-owned launch/await.

## Alternatives considered

**Run a periodic timer.** Rejected because it adds timer lifecycle, overlap control, and another interval knob. A long-lived process may retain files until restart.

**Delete spills on session disposal.** Rejected because durable sessions, resumes, and forks retain locators.

**Delete old session directories recursively.** Rejected because a concurrent process may create a fresh spill after the age check. Per-file expiry preserves fresh writes.

**Tie cleanup to session-persistence deletion.** Rejected because the persistence seam has no common deletion lifecycle, while the local backend also owns independent temporary roots.

## Consequences

Cleanup cost the backend a startup sweep and a config knob, and bought a bounded local-storage lifetime without a timer, a daemon, or a session-lifecycle coupling. Concurrent processes may duplicate startup I/O; strict filtering and idempotent file deletion keep this safe. A long-lived process is not cleaned again until restart, and retention deliberately makes old model-visible locators stale only once they age past the cutoff. The seam itself still defines no retention policy — this is a local-backend concern.

## Testing

`dsh-spill-local` unit tests cover the age boundary (strictly-older expires, boundary kept), `cleanupPeriodDays: 0` disabling, discovered-root pruning, active-directory preservation, symlink/unrelated-entry skipping, configured-plus-discovered-root coverage through the real `gatherRoots`/`discoverDefaultRoots` path, active-root de-duplication, load-time validation of a bad `cleanupPeriodDays`, filesystem- and warning-sink-failure containment both directly and through the service's `ctx.logger.warn` wiring, and the quiescence contract — activation is available while a barrier-held sweep is parked, and disposal only settles after the sweep finishes.
