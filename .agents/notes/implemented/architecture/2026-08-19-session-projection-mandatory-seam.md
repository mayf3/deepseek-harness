# Agent Note: Session projections as a required seam

Status: implemented

English | [中文](2026-08-19-session-projection-mandatory-seam.zh.md)

## Problem

An optional projection registry lets contributors and readers activate without the service, silently dropping host state, client read models, or subagent catalog fields. Batch-only reads also materialize every client view when a consumer needs one host value.

## Decision

This decision builds on the split between host projection state and client views in [Session projection state and client views](2026-08-19-session-projection-state-and-client-views.md).

`sessionProjections` is a required injection for every plugin that contributes or reads a projection unit. Official compositions mount the registry before those plugins. `ApiProxyService` follows the same rule; the lower-level `createApiProxy` factory remains tolerant for isolated tests and diagnostics.

The registry provides `stateOf(session, key)` for one typed host state and keeps `snapshot()` for batch carriers. Client views contain only consumed fields; host readers use `stateOf` for richer state.

`onChanged` publishes client-visible value changes only. Unit registration and removal remain effect-scoped registry lifecycle; `register()` returns the exact Cordis disposer so a composite domain owner can finish cleanup against projected state before removing its unit. Registration changes do not create a second Host event stream or client tombstone protocol. A later authoritative history or list baseline reflects the active key set.

## Alternatives considered

- **Keep the registry optional.** This preserves more partial compositions but makes missing read models indistinguishable from valid absence. Rejected because official profiles already mount the registry and configuration errors should fail at load.
- **Use `snapshot()` for every read.** This keeps one method but computes unrelated wire views and encourages consumers to depend on batch transport data for host logic. Rejected in favor of typed single-key state reads.
- **Send full host values to clients.** This avoids separate view types but exposes provenance and policy knobs that no client consumes. Rejected in favor of explicit cropped views.
- **Broadcast registry additions and removals across Host and mux streams.** The streams have no shared ordering, so clients need tombstones, buffered frames, and baseline retries to reconcile them. Rejected because plugin-key churn does not justify a second synchronization protocol.

## Consequences

- Missing projection composition fails during plugin activation.
- Host consumers avoid repeated whole-registry snapshots and log scans.
- Wire payloads exclude host-only fields and per-key watermark wrappers; ordinary baselines communicate the active key set.
