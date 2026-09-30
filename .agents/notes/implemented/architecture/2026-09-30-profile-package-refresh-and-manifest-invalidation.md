# Agent Note: Expire HMR package configuration

Status: implemented

English | [中文](2026-09-30-profile-package-refresh-and-manifest-invalidation.zh.md)

## Problem

- **HMR handled module contents but not package.json.** `packages/boot/hmr` clears module caches on a source change and re-imports the loaded URL. A plugin directory's package.json is not a module: HMR ignored its change and kept Node's package-configuration caches (the C++ package.json reader cache, `package_json_reader`'s nearest-manifest cache, the ESM `ResolveCache`, and CommonJS `_pathCache`). Later reloads and imports kept the old exports, main, and imports, and format detection kept the old type.

## Decision

### Responsibilities

| Owner | Does | Does not |
|---|---|---|
| HMR (`packages/boot/hmr`) | Expires a package's configuration caches when a package.json inside its watched roots changes | Reload plugins for a package.json change; handle `node_modules` |

### HMR package-configuration expiry

In HMR's change dispatch, a changed file named `package.json` outside `node_modules` goes to `PackageManifests.invalidate()` instead of `partialReload`. Source changes in the same batch reload afterwards and read the new configuration.

`invalidate(manifest)` records the directory as expired. Afterwards:

- package.json reads, scope lookups, type lookups, and nearest-manifest lookups below that directory read the current file. Ownership follows the real directory when a consumer reaches the package through a link.
- ESM `ResolveCache` entries whose parent lies in that directory or whose result points into it are deleted.
- CommonJS `_pathCache` entries whose result or lookup path lies in that directory are deleted.

Loaded modules stay unchanged. A reloaded plugin is re-imported from its loaded URL, so an entry rename takes effect when the Loader entry restarts, for example after disabling and enabling it, when the Loader resolves the package name again.

The implementation lives in `packages/boot/hmr/src/package-manifest.ts`, which encapsulates every Node internal interface it needs; `index.ts` adds only the dispatch branch, a field, and restoration on disposal. HMR's `node_modules` exclusion is unchanged.

| Interface | Action |
|---|---|
| modules binding `readPackageJSON`, `getPackageScopeConfig`, `getPackageType` | Replaced: paths in an expired directory read the current file; other calls reach the native method |
| `package_json_reader.getNearestParentPackageJSON` | Replaced: expired directories bypass its JS cache; a lookup without a manifest returns the native absent result |
| The ESM Loader's `ResolveCache` instance | The prototype `get` is replaced for one lookup to obtain the instance and restored at once; entries are then deleted by parent |
| CommonJS `Module._pathCache` | Entries below an expired directory are deleted |

The binding's `getNearestParentPackageJSON` is called only by `package_json_reader` and is not replaced. The replacements are installed at the first expiry and restored when the HMR service is disposed.

### Unsupported scenarios

Overwriting or upgrading a package installed in `node_modules`, and reinstalling at the same path after removal, still require restart. Module caches, `node_modules` package-configuration caches, and HMR's `node_modules` exclusion are unchanged.

## Alternatives considered

**Let HMR reload packages inside `node_modules`.** It requires finding affected plugins over a module graph that includes `node_modules`, preventing duplicate evaluation of shared libraries and Cordis, and handling missing dynamic-import edges, module side effects, and Workers. It is not done here; those scenarios keep requiring restart.

**Reload plugins when package.json changes.** package.json is not a module, and changing it does not necessarily call for re-evaluation; source HMR is driven by source changes. After expiry, the next source reload or new import reads the new configuration.

**Re-import reloaded plugins by package name.** It would let an entry rename follow a source reload, but changes `partialReload`'s rule that the loaded URL is the reload unit. Entry renames already take effect when the Loader entry restarts, so this is not changed.

## Verification

| Coverage | Location |
|---|---|
| Expired exports, main, imports, type, scope, and nearest manifests; parity with the native reader; the `node_modules` boundary; restoration | `packages/boot/hmr/tests/package-manifest.spec.ts` |
| HMR dispatch: a manifest change alone reloads nothing, a same-batch source reload reads the new imports, an entry restart reads the new entry, and `node_modules` manifests are ignored | `packages/boot/hmr/tests/package-manifest-dispatch.spec.ts` |

Tests need no API key and make no model calls.

## Consequences

- During HMR development, changes to package.json imports, exports, main, and type reach the next reload or new import; package.json alone triggers no reload.
- Package configuration below expired directories is parsed in JavaScript and must keep the native reader's field and error semantics; tests compare it with the native reader on Node 22, 24, and 26.
- The implementation depends on several Node internal interfaces, and these tests must run again for Node upgrades.
