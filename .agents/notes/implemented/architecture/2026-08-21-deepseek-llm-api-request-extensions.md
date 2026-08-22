# Agent Note: DeepSeek LLM API request extensions for plugin package metadata

Status: implemented

English | [中文](2026-08-21-deepseek-llm-api-request-extensions.zh.md)

## Problem

Provider-side diagnosis needs the exact active plugin package versions that produced an official DeepSeek request. The existing browser-facing plugin inventory reports configured Loader rows and lifecycle phases but owns neither package-manifest resolution nor the requesting agent's standing preset composition.

This metadata belongs only on the official DeepSeek adapter path. Adding it to `GenerateOptions` or the provider-neutral LLM seam would expose a DeepSeek wire concept to pi-ai and every future adapter.

The adapter also needs one plugin-owned extension point. Importing Loader, preset, and package-manifest logic directly into `llm-deepseek` would make the transport own metadata discovery and prevent independent request fields from evolving as plugins.

## Decision

`@deepseek-ai/dsh-deepseek-llm-api-extensions` registers `ctx.deepseekLlmApiExtensions`, an additive registry of top-level fields for `deepseek-official` request bodies. A contributor claims one declaration-merged field with `register()`. The adapter invokes `prepare()` after serializing the exact wire messages, passes the request cancellation signal, rejects preparation or base-field collision before HTTP, merges the detached fields, and calls the captured `accept()` transaction after HTTP 2xx. The registry stops awaiting preparation after cancellation even if a contributor ignores the signal. Acceptance failures remain request failures under `REQUEST_EXTENSION`; transport and non-2xx failures never accept a contribution. A composition without the registry retains the reusable base adapter.

Shipped compositions mount the registry and the default-on plugin-package contributor. Keyless `deepseek-official` replay invokes preparation with a synthetic empty base body and the same acceptance transaction before its first recorded chunk, preserving post-2xx extension side effects rather than field bytes. The provider-neutral `llm` package and `llm-pi-ai` contain no extension type, service lookup, field merge, or acceptance call.

## Plugin package field

`@deepseek-ai/dsh-plugin-package-inventory-deepseek` owns the default-on `dsh_plugin_packages` field from the `llm` package family. It reads active non-group entries from the host Loader tree and, for a live requesting Agent, its standing preset tree. Node package resolution locates the owning manifest without requiring a `./package.json` export. Ordinary entries resolve from their owning tree, while a standing preset root mirrors its Loader's intentional harness-base override and nested includes retain their own bases. An anonymous nearest manifest marks a loose module; a named manifest must carry a version. Exact name/version pairs are deduplicated with deterministic ordering; simultaneously active versions remain separate.

Disabled, pending, failed, unloading, disposed, structural, loose non-package, ordinary dependency, programmatic child-fiber, and in-memory dynamic-plugin entries are outside this package inventory. This definition reports package-backed composition facts the runtime can prove instead of inventing provenance for arbitrary callbacks.

## Deferred inventory caching

The implementation deliberately recalculates the active package set for every request while caching manifest identities for the process lifetime. A synthetic host-only benchmark on Node v24.16.0, macOS arm64 used unique active relative plugin packages, 20 warm-up requests, then 500 measured requests for 25 and 100 entries and 250 for 500 entries. “First request” includes uncached manifest reads; “cached-provider median” returns a prebuilt field through the same registry, so it retains `structuredClone()` and freeze costs but excludes adapter JSON serialization and network time.

| Active entries | First request | Current warm median | Current warm p95 | Cached-provider median |
|---:|---:|---:|---:|---:|
| 25 | 1.23 ms | 0.05 ms | 0.07 ms | 0.02 ms |
| 100 | 2.23 ms | 0.14 ms | 0.24 ms | 0.04 ms |
| 500 | 10.22 ms | 0.60 ms | 0.79 ms | 0.18 ms |

These measurements keep the cache deferred: even 500 entries stay below one millisecond at steady state, and the estimated saving is about 0.42 ms before unavoidable JSON serialization. A real profile showing material `prepare()` latency is the trigger to add the cache rather than a fixed entry-count threshold.

The deferred design uses one monotonic inventory epoch. A global `internal/status` listener advances it whenever a Loader entry's root fiber crosses the `FiberState.ACTIVE` boundary, covering dependency activation, disablement, unload, and HMR without a time-based stale window. The contributor caches the Host snapshot by epoch, caches each standing preset `EntryTree` in a `WeakMap`, and caches the combined Host-plus-preset result by tree and epoch. Already-sorted snapshots merge and deduplicate exact `(name, version)` pairs in linear time. A calculation whose epoch changes before settlement retries instead of publishing a stale snapshot; disposed preset trees remain collectible through the `WeakMap`.

The process-lifetime manifest-identity cache remains separate because in-process package-version replacement is not supported.

## Verification

Registry tests pin duplicate ownership, effect-scoped disposal, detached field values, concurrent and abortable preparation, receiver-preserving acceptance, one acceptance settlement, and failure aggregation. Package-inventory tests pin default-on and explicit-off policies, host and standing-preset discovery, conflicting Loader resolution bases, manifest resolution, lifecycle filtering, and exact name/version ordering. The direct adapter mock proves pre-HTTP preparation failure, cancellation, non-2xx non-acceptance, 2xx acceptance before a later stream failure, and field collision. Keyless replay pins post-2xx extension acceptance, real Loader composition inspects the default metadata field, one credentialed real-API request mounts the production contributor, and pi-ai tests retain their unchanged wire requests.

## Alternatives considered

**Add generic metadata to `GenerateOptions` or `ctx.llm`.** Rejected because the value and acceptance timing are DeepSeek wire semantics; a provider-neutral request would make every adapter understand or ignore a foreign field.

**Hard-wire package discovery into `llm-deepseek`.** Rejected because the adapter would import Loader, preset, and package-manifest logic. The registry keeps transport responsible only for field merge and HTTP acceptance.

**Inventory every live Cordis fiber.** Rejected because programmatic and in-memory fibers have no authoritative npm package provenance. Loader-backed host and preset entries provide exact resolvable package identity.

**Cache one process-global list or expire it on a TTL.** Rejected because one immutable list is incorrect for Loader lifecycle and per-Session presets, while a TTL permits stale metadata between expiry boundaries. The deferred epoch design invalidates on the authoritative active-state transition instead.

**Replace the complete field with a content hash or server-side inventory reference.** Rejected because it changes standalone request reconstruction and requires endpoint state plus a later wire version. That is a wire-byte protocol change, not a computation-cache optimization.

## Consequences

Official DeepSeek requests carry active package versions to their resolved `baseURL`, including configured gateways. The field is model-hidden and adds no prompt tokens or KV-cache changes. Manifest resolution, field collision, acceptance handling, or provider schema rejection fails the model request rather than silently dropping metadata.

Direct calls without a live Agent still carry the host package inventory. The [DeepSeek request-identity decision](../feature/2026-08-11-deepseek-request-user-id-header.md) continues to own user/session headers, which remain outside the body.
