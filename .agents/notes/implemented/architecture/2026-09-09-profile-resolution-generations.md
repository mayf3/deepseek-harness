# Agent Note: Add immutable profile resolution generations

Status: implemented

English | [中文](2026-09-09-profile-resolution-generations.zh.md)

## Problem

A profile loads plugin rows from its own package project, while Harness packages and packages carried by selected bundles can live outside that project's ordinary dependency tree. Bridging the trees through shared symlinks, profile-owned links, or packaged-executable proxy packages persists package selections across processes and installations. Those files require reconciliation and locking, expose generated proxy manifests to metadata readers, and cannot represent a process-local change atomically.

The runtime design keeps installation-first, ordered-bundle, and local-before-fallback precedence. It covers imports performed by plugin modules as well as Loader row imports and works in the main thread and Harness-owned Workers. Generation replacement accepts only additive package sets and never mutates a live table entry by entry.

## Decision

Profile startup computes one immutable `ProfileResolutionGeneration` and installs it into Node's ESM and CommonJS resolvers. Runtime is the only resolution backend; there is no mode selector or disk materializer. `PluginPackages.replace()` publishes a complete additive successor with one reference replacement.

### One selection algorithm

The package traversal belongs to `@deepseek-ai/dsh-app-boot` beside profile loading. Ordinary Node, source launches, packaged executables, and the Electron Host consume the same generation and runtime resolver.

The installation manifest is the first root. Its graph traverses `dependencies` followed by `peerDependencies` breadth-first, resolving each edge from the manifest that declares it. The first installed package reached under a name owns that name. Selected bundle roots then run in profile order, with each earlier root's complete graph taking precedence over every later root. Names supplied by the installation are reserved, and bundle package roots themselves do not become plugin fallbacks. Missing declared packages are skipped.

During dependency expansion, every installation root, selected bundle root, and recursive dependency manifest uses its package's real directory as the lookup anchor. Ancestor `node_modules` searches therefore follow the location from which Node normally executes the package, not the location of a symlink pointing to it. The same declaring anchor is recorded for runtime delegation. This can change the selected version or remove an otherwise discoverable dependency when logical and real ancestors differ; it is not merely a spelling change to stored paths.

Profile-local and plugin-private `node_modules` entries take precedence over fallback entries. The generation records installed direct profile package names for a no-I/O native fast path. Each fallback entry records the package name, version, selected lookup directory, declaring manifest anchor, and scope needed for native resolution and successor validation.

The selected-bundle module fallback remains necessary for dependencies that the profile cannot find through its own ancestor directories. It expands installed manifest dependencies into the active profile's shared fallback table, not a separate graph for each plugin. It neither downloads packages nor scans source imports. Runtime hooks consume that table after native local candidates have been considered.

### Ordinary and linked package examples

In both layouts below, the profile selects `my-bundle`, whose manifest declares `bridge`; only `bridge` declares `leaf`. Neither the installation nor the profile's direct packages supplies `leaf`, and `bridge` has no private `node_modules/leaf`. The paths illustrate the two layouts exercised by the [shared CLI profile tests](../../../../apps/cli/tests/profiles/headless/tests/profile-resolution.ts).

With ordinary installed directories, `bridge` searches its containing bundle's `node_modules` and finds version 1.0.0. The unrelated version 2.0.0 is not on that search path:

```text
/case/home/profiles/headless/node_modules/my-bundle/
  node_modules/bridge/
  node_modules/leaf/                                  # 1.0.0
/case/dependencies/node_modules/leaf/                 # 2.0.0
```

With an npm-link-style bundle and a linked transitive dependency, the bundle expands from `/case/work/my-bundle`, and the next dependency expansion starts at `/case/dependencies/bridge`. That expansion finds version 2.0.0 beside the real package:

```text
/case/home/profiles/headless/node_modules/my-bundle -> /case/npm-global/node_modules/my-bundle
/case/npm-global/node_modules/my-bundle -> /case/work/my-bundle
/case/work/my-bundle/node_modules/bridge -> /case/dependencies/bridge
/case/work/my-bundle/node_modules/leaf/                # 1.0.0
/case/dependencies/node_modules/leaf/                 # 2.0.0
```

| Profile package layout | Declaring directory used to resolve `leaf` | `tsx/esm` source launch | Plain Node `lib` launch |
|---|---|---|---|
| Ordinary directories | `/case/home/profiles/headless/node_modules/my-bundle/node_modules/bridge` | 1.0.0 | 1.0.0 |
| Linked bundle and bridge | `/case/dependencies/bridge` | 2.0.0 | 2.0.0 |

ESM `import` and CommonJS `require` select these versions. Within each module format, importing `leaf` through profile fallback and importing it inside `bridge` reaches the same module instance. A higher-priority native profile package or an installation-reserved fallback name still wins according to the selection rules; the fallback does not force every importer to use version 2.0.0.

### Source and built module identity

The [source launcher](2026-07-29-dsh-source-launch-tsx-esm.md) uses tsx's ESM-only hook. tsx skips tsconfig `paths` for an importer URL containing `/node_modules/`. A logical workspace symlink used as a fallback declaring anchor can therefore select built `lib/` exports, while imports from the resulting real workspace files select `src/` through the paths map. Real declaring anchors let workspace imports follow the source map consistently; packages without a matching workspace mapping keep ordinary package-export resolution.

For example, `@deepseek-ai/dsh-tools` creates its scheduler key with `Symbol()`. A Tools instance loaded from `lib/` cannot expose that scheduler through a key imported from the separate `src/` module instance. Source launches keep Tools and AgentLoop in `src/`; plain Node launches keep them in `lib/`. The scheduler retains its local Symbol; correct imports share one module instance.

### Immutable generations

A resolver registration holds one `current` generation. Each synchronous resolution captures that reference once. Generation construction reads every required manifest before publication; an error leaves the current generation unchanged. Successful publication replaces one reference, and in-flight calls may finish against the generation they captured.

Selection and package-metadata caches belong to a generation. Publishing a successor invalidates them by making the old generation unreachable after its callers finish; update code does not mutate or clear individual entries. A generation hit and a successful native selection can be cached, but a generation miss is rescanned so a profile-local package installed after the miss becomes visible through native lookup. Calls with explicit CommonJS paths or non-default conditions never reuse a default-resolution cache entry.

The launcher constructs one startup generation. The service accepts an additive successor, but no package-manager transaction invokes replacement in this implementation.

### Shared ESM and CommonJS rule

The resolver uses `node-addon-require-builtin` to read `internal/modules/esm/loader` and `internal/modules/cjs/loader`. The ESM adapter wraps the per-thread singleton `CascadedLoader` resolve methods. The CommonJS adapter wraps the internal builtin's `Module._resolveFilename`; that `Module` is the same object exported by `node:module`.

Both adapters call one routing function. It ignores builtins, relative or absolute paths, URLs, parents outside the profile scope, and explicit calls outside the supported lookup. A `#imports` request uses Node's mapping from its owning manifest; an external bare target follows the same local, generation, and after-fallback package order with the request's conditions, while Node retains exact target resolution. For a scoped bare request, a package self-reference keeps the original parent even when an npm alias gives its installed directory another name. A profile-local or plugin-private package also keeps the original parent when Node resolves the requested entry before the virtual shared-fallback position; a CommonJS package directory without `exports` does not suppress the fallback when only its requested subpath is absent. Otherwise the router uses a generation hit through that entry's declaring anchor or continues native lookup after the virtual fallback. Explicit CommonJS path lists apply the same insertion rule independently to each path in caller order.

The adapters call the captured native resolver after routing. Node remains responsible for exports, import and require conditions, main files, subpaths, extensions, native caches, and error codes. Routed ESM failures replace the internal lookup anchor in Node's diagnostic with the original importer. A selected package's invalid export or missing target does not trigger another same-name candidate. CommonJS does not replace `_findPath` or reproduce `_resolveFilename`.

The guarantee covers Node's default `import`, `import()`, `import.meta.resolve`, `require`, and `require.resolve` after installation in that thread. It does not cover already linked modules, custom `vm` linkers, opaque non-Node importers, or third-party Workers.

### Active plugin list and package metadata

The resolution generation lists available fallback packages; Loader entries form the active plugin list. Consumers keep using Loader's existing entry lifecycle and filter the entries relevant to their own scope. Consumers that need package metadata pass a specifier and owning tree base URL to a lightweight `app-boot` service without requiring a `./package.json` export. An installed generation is authoritative, including a miss; a service created without a generation retains native lookup for low-level embedders.

The resolver does not expose `imported(entry)` and does not observe ModuleJobs, wrap Entry methods, associate fibers with import calls, replace registry or tree methods, or adapt HMR transactions. A repeated query uses the same generation and therefore cannot drift from the route used for the import. Non-Node importers that need package metadata must explicitly implement the same deterministic resolver interface.

The implementation lives under `app-boot/src/profile-resolution/`. `service.ts` provides the long-lived `ctx.pluginPackages` and owns the main-thread resolver and Worker-generation lifetimes; `resolver.ts` implements generation lookup and the Node Internal adapters; `worker-bootstrap.ts` installs an inherited generation in one thread. Profile selection and generation construction remain in `profile.ts`. Workers reference the bootstrap only through the public `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap` export.

The service definition and provider remain together in `app-boot` because profile boot owns the resolver lifetime. Extracting a separate capability seam becomes warranted when a launcher-independent provider or independently evolving consumers require it.

### Workers and generation updates

The main thread publishes a structured-clone representation of the current generation through Worker environment data. Each built Harness-owned Worker uses its build banner to obtain its own ESM and CommonJS internal objects and install the same adapters without traversing manifests. The bootstrap bundle has no static package imports. Source Worker entries retain their existing self-contained dependencies. Third-party Workers remain unchanged.

New Workers inherit the latest published generation. Existing Workers keep the generation they inherited, so a caller that publishes a successor must restart them. The ESM bootstrap cannot affect static dependencies linked before its execution, so Worker bundles keep pre-bootstrap static imports natively resolvable and start code needing the profile resolver through a later dynamic import.

### Additive package changes

A caller adding a package completes its pnpm transaction before constructing a successor generation. Replacement rejects any generation that changes the directory or version of an existing package. The caller publishes an additive successor before mounting the new Loader row; this implementation does not provide that package transaction. A mount failure may leave the package installed but inactive.

Replacing, upgrading, or removing an already loaded package requires process restart because Node's ESM Module Map, CommonJS cache, existing object references, and running Workers can retain the old module identity. Generation replacement does not claim to unload modules.

### Filesystem and runtime carriers

The resolver does not create, update, or remove fallback symlinks and proxy packages. Generation entries occupy their package names at `$DSH_HOME/profiles/node_modules`; every other name sees that directory as an ordinary ancestor, and symlinks anywhere in the profile tree are ordinary filesystem content without dedicated recognition. Profile-local package metadata and bundle dependency discovery follow the same Node lookup; ordinary pnpm-installed packages retain native precedence. The [lookup-order Note](2026-09-19-profile-resolution-lookup-order.md) records the complete order. Writable profile state and package-manager transactions remain outside the resolver.

Runtime resolution requires a supported Node Internal loader interface. The Electron Host runs through the Electron executable with `ELECTRON_RUN_AS_NODE=1`; packaged builds read the dsh tree from ASAR and map executable ASAR entries to electron-builder's unpacked tree. Pkg and Electron use the same runtime-generation mechanism as ordinary Node launches.

### Performance and verification

Generation construction is startup or update work, not resolve work, and its absolute latency is reported separately. Ordinary hot paths consist of scope classification, bare-name extraction, local-before-fallback selection, a Map lookup, and one native resolution; a cache hit returns the generation-owned result directly. A CommonJS request may perform one native probe followed by one routed resolution when a local package directory exists without `exports` but lacks the requested subpath. Out-of-scope calls do not read manifests and cache only whether each parent belongs to the profile scope.

One-off local measurements taken during implementation ran built JavaScript under plain Node in fresh processes and compared it with a process that installed no hook. The measurement script and results are not committed, and these figures are not a benchmark or CI budget. Seven alternating rounds covered outside, profile-local, and fallback imports through dynamic import, `import.meta.resolve`, require, and `require.resolve`. Across Node 22.19, 24.18, and 26.8, the largest positive hot-path median was 4.5%. On Node 24.18, a 256-package cold workload regressed by at most 11.2% and generation construction took 16.027 ms median; the 32-package local `require.resolve` case added 1.033 ms across the batch (+34.7%) from fixed startup cost.

Behavior tests exercise root order, transitive and peer dependencies, local and external precedence, exports and subpath errors, conditions, and explicit CommonJS options. The Node compatibility matrix runs the resolver, service, and bootstrap specifications across the supported internal-loader variants. Worker tests verify environment-data publication and bootstrap installation with mocked thread and native-loader interfaces; they do not launch a built Worker. Generation tests prove failed construction does not publish partial state and successful replacement is atomic.

## Alternatives considered

**Keep disk projections permanently.** This preserves native lookup without process hooks, but retains cross-process mutation, stale generations, proxy manifests, writer locks, and packaged-runtime divergence. Retaining link and dual as comparison modes would also keep the materializer and its lifecycle without a supported launcher that needs them.

**Preserve logical symlink anchors.** This keeps lookup under the symlink's ancestors, but can select a different dependency from the one imported by the real package and can suppress tsx's workspace paths map. Canonical anchors keep eager dependency discovery and runtime delegation aligned with the package's execution location.

**Expand the dependency graph lazily during resolve.** This spreads manifest reads and errors across first-use calls, changes timing from the disk implementation, complicates Worker startup, and makes the hot path depend on graph size. Complete generation construction is easier to compare and replace atomically.

**Use `module.registerHooks`.** The public API puts every relevant resolution through Node's global hook dispatch before profile scope can reject it. Direct access to the existing internal ESM and CommonJS resolver objects permits a smaller fast path while retaining Node as the final resolver.

**Record each Entry's actual import through Loader and HMR adapters.** Actual import records support stateful resolvers that return different targets for identical inputs. This design instead makes the generation authoritative and deterministic, so those records duplicate the resolver's answer while adding Entry, fiber, registry, ModuleJob, and HMR lifecycle state.

**Mutate one long-lived table after each package operation.** Incremental mutation exposes partial graphs and requires targeted cache invalidation. Building a complete successor makes failure atomic and keeps all caches generation-owned.

**Hot-replace already loaded package versions.** A resolution-table swap cannot invalidate every live module instance or object reference. Restart preserves one package identity per process.

## Verification

- One eager computation supplies the runtime generation; startup neither writes nor retires module-resolution data.
- [Generation tests](../../../../packages/boot/app-boot/tests/profile-resolution.spec.ts) cover installation and selected-bundle graphs with ordinary directories and recursive symlinks, including different dependency versions beside logical and real anchors.
- [Source-launch tests](../../../../apps/cli/tests/source-launch.compat.spec.ts) and [built-bin tests](../../../../apps/cli/tests/built-bin.e2e.ts) run both profile layouts through the real CLI. They assert ESM/CJS versions, loaded paths, per-format dependency identity, and consistent Tools/AgentLoop module instances with an accessible scheduler key.
- Pkg and Electron carriers select runtime resolution; Electron executes its Host in Node mode from the ASAR-backed dsh tree while native executable entries remain unpacked.
- ESM and CommonJS adapters share one router and delegate final resolution to Node without `module.registerHooks` or `_findPath` replacement.
- Production metadata lookup does not record Loader import results or wrap Entry, registry, tree, or HMR methods.
- The Node compatibility matrix runs main-thread resolver specifications across supported loader interfaces; service and bootstrap specifications cover Worker environment-data and installation interfaces without launching a built Worker.
- One-off built plain-Node measurements produced the hot and cold observations above against no-hook Node; the script and results are not committed evidence.

## Consequences

Runtime startup avoids disk mutation and proxy manifests while retaining package-precedence rules. Real-directory anchors align dependency discovery with default Node loading and tsx workspace mapping, including cases where a logical symlink path would select another version. The implementation accepts the maintenance cost of Node Internal compatibility tests and an early, self-contained bootstrap in each owned Worker; it provides no disk-only backend or dual comparison mode. Generation replacement remains additive until the product owns module-cache invalidation and Worker restart.
