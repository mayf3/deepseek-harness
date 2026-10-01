# Agent Note: Expire HMR package configuration

Status: implemented

English | [中文](2026-09-30-profile-package-refresh-and-manifest-invalidation.zh.md)

## Problem

- **Package configuration and module evaluation have separate caches.** Clearing a plugin's module cache does not refresh the package.json fields that Node uses for exports, main, imports, and format detection. A package.json can also be imported as a JSON module, in which case its consumers need ordinary module reloads.

## Decision

### Responsibilities

| Owner | Does | Does not |
|---|---|---|
| HMR (`packages/boot/hmr`) | Expires package configuration and preserves ordinary reloads for manifests loaded as JSON modules | Reload plugins for configuration-only manifests; handle `node_modules` package replacement |

### HMR package-configuration expiry

In HMR's change dispatch, a changed file named `package.json` outside `node_modules` goes to `PackageManifests.invalidate()`. A manifest in the host dependency graph still requests a host reload; one loaded as a JSON module still reloads its consumers. A configuration-only manifest schedules no module reload. Configuration-owned paths stay with their dedicated watcher. Source changes in the same batch reload afterwards.

`invalidate(manifest)` records the directory as expired. Afterwards:

- package.json reads, scope lookups, type lookups, and nearest-manifest lookups below that directory read the current file. Ownership follows the real directory when a consumer reaches the package through a link.
- ESM `ResolveCache` is cleared. Its entries do not record every consulted manifest, and a package entry may resolve outside the package directory.
- CommonJS `_pathCache` is cleared for the same reason. Unrelated requests recompute their resolution without unloading their modules.
- CommonJS loads using the default resolver pass the freshly resolved filename to the native loader. Its private request alias cannot select an older entry; cached module instances remain intact.

Configuration invalidation alone leaves loaded modules unchanged. Stopping and restarting a Loader entry resolves its package name again and selects the new entry. Tracking active entry URLs independently of later package-name resolutions is deferred.

The implementation lives in `packages/boot/hmr/src/package-manifest.ts`, which encapsulates its Node internal interfaces. `index.ts` dispatches manifest changes without changing the module-reload algorithm. HMR's `node_modules` exclusion is unchanged.

| Interface | Action |
|---|---|
| modules binding `readPackageJSON`, `getPackageScopeConfig`, `getPackageType` | Replaced: paths in an expired directory read the current file; other calls reach the native method |
| `package_json_reader.getNearestParentPackageJSON` | Replaced: expired directories bypass its JS cache; a lookup without a manifest returns the native absent result |
| The ESM Loader's `ResolveCache` instance | The prototype `get` is replaced for one lookup to obtain the instance and restored at once; the resolution cache is then cleared |
| CommonJS `Module._pathCache` | The request-to-filename cache is cleared |
| CommonJS `Module._load` | Default-resolver requests load by resolved filename; builtins and registered resolve hooks keep the original path |

The binding's `getNearestParentPackageJSON` is called only by `package_json_reader` and is not replaced. Each HMR instance owns a separate configuration cache. Its replacements are installed at the first expiry and restored when the service is disposed, alongside watcher and reload-queue cleanup.

### Future Work

- Online replacement inside `node_modules`, same-path reinstall, changed link targets, and cross-package reload propagation remain unsupported. Package updates need process restart; this does not guarantee that every management result already reports that requirement correctly.
- TSX versions using an asynchronous loader thread keep that thread's package configuration outside these hooks. Synchronizing it is deferred; this change does not provide general Worker cache synchronization.
- After exports or main moves an entry, HMR can fail to locate its old loaded module by package name. Keeping an active-entry URL association is deferred; restarting the Loader entry selects the new entry.
- CommonJS private-request-cache refresh with registered synchronous resolve hooks is deferred. Those requests retain their original loader behavior.
- Disposing HMR restores the native readers, whose previous cached configuration can become visible again. Preserving invalidation state across HMR replacement is deferred.

## Alternatives considered

**Let HMR reload packages inside `node_modules`.** It requires finding affected plugins over a module graph that includes `node_modules`, preventing duplicate evaluation of shared libraries and Cordis, and handling missing dynamic-import edges, module side effects, and Workers. It is not done here; those scenarios keep requiring restart.

**Reload every plugin for a package.json change.** Configuration-only manifests do not require module evaluation. Manifests actually imported as JSON modules retain ordinary dependency-driven reloads.

**Re-import reloaded plugins by package name.** It would let an entry rename follow a source reload, but changes `partialReload`'s rule that the loaded URL is the reload unit. Entry renames already take effect when the Loader entry restarts, so this is not changed.

## Verification

| Coverage | Location |
|---|---|
| Expired exports, main, imports, type, scope, and nearest manifests; native-reader parity; actual CommonJS loads and retained module instances; the `node_modules` boundary; restoration | `packages/boot/hmr/tests/package-manifest.spec.ts` |
| Configuration-only manifests, JSON-module and host reloads, source reloads, entry restarts, and the `node_modules` exclusion | `packages/boot/hmr/tests/package-manifest-dispatch.spec.ts` |

Tests need no API key and make no model calls.

## Consequences

- In the supported thread, package.json configuration reads use the changed fields; JSON modules retain their own reload behavior. The separate module, loader-thread, and Worker limitations above still apply.
- Package configuration below expired directories is parsed in JavaScript and must keep the native reader's field and error semantics; tests compare it with the native reader on Node 22, 24, and 26.
- The implementation depends on several Node internal interfaces, and these tests must run again for Node upgrades.
