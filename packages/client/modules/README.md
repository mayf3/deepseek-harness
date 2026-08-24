# @deepseek-ai/dsh-client-modules

English | [中文](README.zh.md)

Client module system: the browser peer of Node's internal ESM loader, built as a lazy CJS table. The web shell mounts the vendored cordis Loader for entry governance (fiber lifecycle, inject waiting, update/refresh) and injects this package's `ClientModuleLoader` through its `internal` contract — the vendored side's only consumption point is `EntryTree.import`, so replacing `internal` replaces exactly "how plugin code arrives" and nothing else.

Lazy CJS model (web2): executing a plugin bundle only REGISTERS its factory (`window.__ModuleLoader__.load({id, factory})`); every module body side effect — CSS injection included — lives in the factory closure and runs at materialization (`factory(require)` → exports, memoized in `loadCache`), not at script execution. A factory that requires another registered-but-unmaterialized module materializes it recursively; graph composition places declared dynamic requests before their consumers, and require cycles throw because factory-form CJS cannot deliver partial exports. `<id>/client` and the bare id resolve to the same exports (a plugin bundle IS its package's client half).

The Host installs `window.__ModuleLoader__`, preloads the application batch, then executes the parser-blocking bootstrap batch. Queue-mode `load()` retains the modules registration; `create()` materializes this package's factory with an external-rejecting bootstrap require and calls its `createClientModuleSystem` export. Construction caches those same exports as the modules row and switches the same facade to live registration. The bundle retains the resulting system in a module closure, so its later Cordis `apply()` provides the identical instance as `ctx.modules` without another page global.

Resolution branch order (`import(specifier)`): platform seed word → shell instance; memoized record → exports; graph row (`window.__DSH_BOOT__`) → register its initial-batch factory; registered factory → materialize; anything else throws — the runtime mirror of the build-time bundle purity gate. The synchronous `require` handed to factories walks the same order minus the asynchronous graph-row load and records observed edges into the module record. `prefetch` is the stage-one arrival hook; rows sharing a batch URL share one in-flight script task. `invalidate(id, rev)` drops a non-bootstrap factory and materialized record and switches that row to its revisioned individual script, so HMR reloads one plugin without executing the batch again.

The Node half scans enabled Loader entries for web `dsh.client` packages, resolves and snapshots each `exports["./client"]` plus its available source map, carries package-specific `dsh.client.external` requests, and orders dynamic providers before consumers. It emits a bootstrap batch for the modules row and an application batch for every other row. Each batch has a content-addressed script and an indexed Source Map v3 file assembled from the available plugin maps. Initial individual revisions are opaque process nonces, so startup does not hash every plugin; HMR hashes only an artifact whose watcher reports a change. Individual revisioned scripts and maps remain available for HMR; every versioned response is immutable, and a revision mismatch returns 404 instead of serving newer bytes under an older URL. Source launch maps host imports to TypeScript source but still consumes these built client exports; missing files share one build instruction followed by a package/path list, while unrelated filesystem errors remain separate failures.

`dsh.client.external` is an optional exact-specifier request list beyond the implicit baseline of shell-seeded React, Cordis, and static UI libraries. A request is answered by the dynamic package row it names or an exact static-table key; only a trailing `/client` aliases a package row, and there is no provider-alias declaration. Type-only imports are erased and create no request. Composition rejects malformed requests, missing suppliers, self-requests, and synchronous request cycles; import and prefetch recursively register dynamic suppliers before their consumers materialize. See [shared modules and the module graph](../AGENTS.md#shared-modules-and-the-module-graph).

## Model Experience

None, as the module loader is browser-side kernel machinery; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Flat module graph by design** — every bundle is one module node whose edges point only at table leaves; the interface (`loadCache`/`edges`/`invalidate`) already supports a general module graph, so the externalization granularity can change without an interface change.
- **No unload bookkeeping of its own** — style removal and fiber teardown ordering live with the HMR driver (`@deepseek-ai/dsh-client-hmr`); the loader only inventories owned style tag ids per record.
- **Snapshot delivery retains artifact bytes** — the Host holds each bundle, optional source map, revision-stamped individual response, and generated batch in memory; HMR additionally retains one prior batch generation. Memory scales as several copies of the composed client artifacts in exchange for immutable responses and one-generation race tolerance.
