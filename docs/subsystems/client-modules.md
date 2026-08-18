# Client Modules

English | [中文](client-modules.zh.md)

The web plugin table: the Node half of the client module system in [dsh-client-modules](../../packages/client/modules), provided as `ctx.clientModules` (`ClientModuleRegistry`). It scans the host Loader's entries for packages declaring `dsh.client`, composes the `window.__DSH_BOOT__` entry graph, serves content-addressed startup batches and individual HMR scripts under `/plugins`, and answers every index-injection collection with the boot protocol rows — the four faces of one service. It is an optional capability of the web GUI stack, not part of the agent-loop spine, and it is a consumer of [dsh-host-webserver](../../packages/host/webserver): the carrier described in [web-server.md](web-server.md) supplies the prefix route and the `webserver/index-inject` event this service answers. The same package's browser half (`ctx.modules`, the lazy-CJS module table that fetches and materializes these bundles) is kernel machinery documented in the [package README](../../packages/client/modules/README.md), not here.

Source: [`packages/client/modules/src/client/manifest.ts`](../../packages/client/modules/src/client/manifest.ts)

## The wire

The graph is the wire single source between the Node and browser halves. The host composes `WebBootEntry` rows and `WebBootBatch` descriptors from scanned packages, then contributes the registration facade, application preload, bootstrap script, and graph global to the structured index-injection table before the Vite entry. The `global` row renders as `globalThis["__DSH_BOOT__"]` with `<` escaped so plugin-controlled strings cannot break out of the script element. A page without a valid manifest cannot boot: the browser parser rejects malformed rows or batches, duplicate phase names, unknown members, and entries without exactly one initial batch.

```ts type-equiv
/**
 * One composed client entry pushed by the host (a graph row). Wire
 * single source: the host node half (package root) produces this same shape.
 * `immediately` marks stage-one prefetch. `inject` names package rows whose
 * factories must arrive before this row materializes, while Cordis separately
 * uses the same package edges to compose entries. `external` carries exact
 * non-inject module requests (see {@link WebBootGraph.entries}).
 */
interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  /** Revisioned individual endpoint used by HMR. */
  url: string
  /** Hash over the individual bundle and available source map. */
  rev: string
  /** Package-name dependency edges used for factory arrival and plugin composition. */
  inject?: string[]
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
  /** Non-baseline module specifiers this row requests; omitted when it requests none. */
  external?: string[]
}
```

```ts type-equiv
/** Initial script-delivery phase for one content-addressed bundle batch. */
type WebBootBatchPhase = 'bootstrap' | 'application'
```

```ts type-equiv
/** One initial-load script containing the factory registrations for several graph rows. */
interface WebBootBatch {
  /** Parser-blocking bootstrap or preloaded application delivery. */
  phase: WebBootBatchPhase
  /** Content-addressed batch script endpoint. */
  url: string
  /** Hash over the batch script and indexed source map. */
  rev: string
  /** Graph entry ids whose factories the script registers, in execution order. */
  entries: string[]
}
```

```ts type-equiv
/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
interface WebBootGraph {
  /** Consistency anchor over the whole graph (content + bundle hashes). */
  rev: string
  /**
   * Composed entries in module-graph order — a dynamic package row precedes
   * rows whose `external` requests that package. Cordis activation order is
   * unrelated and remains owned by fiber service waiting.
   */
  entries: WebBootEntry[]
  /** Initial-load batches; every entry belongs to exactly one batch. */
  batches: WebBootBatch[]
}
```

Each row's `rev` hashes the individual bundle and its available source map. The bootstrap batch contains the modules row; the preloaded application batch contains every other row. Batch revisions hash the generated script and indexed source map, and the graph revision hashes both rows and batch descriptors. `immediately` marks the stage-one registration barrier; application rows share one script transport even when only some carry the mark.

## The scan

A package joins the table by declaring `dsh.client` (`platform: 'web'`, optional `inject` edges, optional `immediately`) in its package.json and exporting its built bundle at `exports["./client"]`. Package resolution anchors at the config tree's `ctx.baseUrl` — the cordis.yml directory, whose package declares every composed plugin as a dependency — and construction throws when that anchor is unset.

Scanning is incremental per package; there is no full-rescan code path. Every cordis `internal/plugin` emission (fiber construction or disposal) marks the fiber's entry name dirty, and a microtask flush reconciles each dirty name against the live loader entries. The activation pass seeds the same dirty set with all current entries and flushes synchronously, so first scan and steady state share one implementation — with opposite failure postures. At activation, a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud `AggregateError` listing every broken package: the fiber FAILS and the boot's fail-loud sweep reports it. In steady state, a broken package logs a warning and must not poison the others.

Package metadata — including the negative "not a client package" verdict — is cached per name and never expires: plugin-set changes take effect on restart. A fiber restart reuses its row and rev untouched; bundle content changes reach the graph only through `rebuilt()`.

## The bundle route and index injection

`GET`/`HEAD /plugins/_batch/<phase>/<rev>/client.js` serves the generated startup scripts, with indexed maps beside them. `GET`/`HEAD /plugins/<id>/client.js?rev=<rev>` serves the snapshotted individual artifact for HMR and stamps the same revision onto its map request. All versioned responses use long-lived immutable caching. Unknown paths, absent maps, missing revisions, and stale revisions answer 404 rather than serving current bytes under an old URL or letting the SPA fallback return HTML as JavaScript; other methods are 405. The injection rows carry the current graph on every index render, so a reload always boots against the live composition.

## The service

`ClientModuleRegistry` (`ctx.clientModules`, defined in [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)) exposes reads and the rebuild face; signatures are in the generated [service catalog](#ctxclientmodules--clientmoduleregistry). `graph()` returns the current composed graph (a stable object between changes) and `clientPath(id)` the bundle's absolute path. `rebuilt(id)` is the only entry point through which bundle content reaches the graph: it re-hashes the file, and only a real rev change recomposes the graph and notifies. `onRebuilt` fires per changed bundle with the new rev; `onGraphChanged` fires after any flush that recomposed the graph (row added or removed, or a rebuilt rev change) and is pull-model — listeners re-read `graph()`. Both notification paths contain listener exceptions so one throwing subscriber cannot skip later subscribers or kill whatever triggered the flush.

In development, [dsh-client-hmr](../../packages/client/hmr/README.md) is the registry's watch driver: its node half stat-polls every graph row's bundle from a synchronously captured baseline, calls `rebuilt(id)` on change, resyncs its watch set through `onGraphChanged`, and broadcasts rev changes to the browser half over SSE. Production graphs omit the HMR row entirely; the module host itself never watches files.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclientmodules--clientmoduleregistry"></a>

### `ctx.clientModules` — `ClientModuleRegistry`

The web plugin table service: incremental `dsh.client` scan + wire composition + bundle route + index injection rows. Construction runs the activation scan synchronously — a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud throw (FAILED fiber; the boot activation audit reports it).

```ts cordis-catalog
/**
 * Current composed entry graph (stable object between changes).
 * @returns the graph served as `window.__DSH_BOOT__`.
 */
graph(): WebBootGraph

/**
 * Absolute path of an entry's client bundle.
 * @param id - entry id (package name).
 * @returns the path, or undefined for an unknown id.
 */
clientPath(id: string): string | undefined

/**
 * Re-hash one bundle (the HMR watch's registration hook — the only entry
 * point through which bundle content changes reach the graph).
 * @param id - entry id (package name).
 * @returns the new rev, or undefined for an unknown id.
 */
rebuilt(id: string): string | undefined

/**
 * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
 * @param listener - receives the entry id and its new bundle rev.
 * @returns the unsubscriber.
 */
onRebuilt(listener: (id: string, rev: string) => void): () => void

/**
 * Fires after any flush that recomposed the graph (row added/removed, or a
 * rebuilt rev change). Pull model: listeners re-read {@link graph}.
 * @param listener - notified with no payload.
 * @returns the unsubscriber.
 */
onGraphChanged(listener: () => void): () => void
```

Source: [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)
<!-- END GENERATED cordis-surface -->
