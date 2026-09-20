# Agent Note: Resolve profile modules along the ancestor chain with an interception layer

Status: implemented

English | [中文](2026-09-19-profile-resolution-lookup-order.zh.md)

## Problem

A profile loads plugins from its own package project. The dsh installation packages and the dependencies embedded in bundles are not on the profile's dependency tree, so Node's default `node_modules` lookup starting from the profile cannot find them.

A developer must be able to restate the resolution rule in one sentence: which part is ordinary Node behavior, which part is dsh's intervention, and where that intervention ends. The previous runtime implementation hid the whole `$DSH_HOME/profiles/node_modules` layer for every package name and kept dedicated recognition code for historical directory layouts, so the rule could not be stated in one sentence and nobody could judge whether a given resolution result was expected.

## Decision

Module resolution inside a profile is an ordinary Node ancestor `node_modules` chain. dsh does exactly one thing: every package name in the runtime resolution computed at startup occupies the package directory position `$DSH_HOME/profiles/node_modules/<package>`. When the chain reaches this layer, a package name with an entry is answered by the runtime resolution's package, and a package name without an entry sees the physical directory at this layer. A plugin linked outside the tree has the same form of interception at its real directory: runtime resolution entries that the plugin declares as peers occupy `<real directory>/node_modules/<package>`. Every other resolution behavior matches Node. [Construction, publication, Worker inheritance, and runtime carriers of immutable generations](2026-09-09-profile-resolution-generations.md) are recorded by the existing Note and are not repeated here.

### Part 1: Resolution rules

#### 1. The ancestor chain: Node's ancestor `node_modules` lookup

The importer is the module file that issues the `import` or `require`. Node starts from the importer's directory, tries the `node_modules` under each directory level upward until the filesystem root, and then tries `NODE_PATH` and the global directories. The nearest layer wins; within one layer, matching is by package name only.

Symlinks are followed to their real path per Node's default behavior. Once a module is loaded by its real path, the ancestor chain for its subsequent imports is the real path's ancestor chain, regardless of where it was linked from.

The chain below defines the numbering that every table in this Note references. The importer is `$DSH_HOME/profiles/web/node_modules/my-plugin/index.js`:

```text
① $DSH_HOME/profiles/web/node_modules/my-plugin/node_modules
② $DSH_HOME/profiles/web/node_modules
③ $DSH_HOME/profiles/node_modules
④ $DSH_HOME/node_modules
⑤ /node_modules
```

① holds the plugin's private dependencies, ② the packages the profile installed, ③ the interception layer where the runtime resolution occupies the package directories it has entries for, ④ the Harness home, and ⑤ the filesystem root followed by `NODE_PATH` and the global directories.

#### 2. The interception layer: the runtime resolution occupies `$DSH_HOME/profiles/node_modules/<package>`

The interception layer is the first ancestor `node_modules` above the importer's profile directory (`$DSH_HOME/profiles/<name>`). For every profile inside the tree this layer is `$DSH_HOME/profiles/node_modules`.

Every package name in the runtime resolution occupies the package directory position `<interception layer>/<package>` at this layer. For an installation package name such as `@deepseek-ai/dsh-tools`, the package directory at ③ is the copy of the running installation; an old link or old directory of the same name on disk is no longer a member of the chain. For a package name absent from the runtime resolution, the package directory at ③ is the physical content on disk.

The order for one bare package name request: the ancestor chain first walks the layers inside the profile directory (① and ②), and when a candidate exists Node resolves inside that candidate and returns. On reaching ③, if the runtime resolution has an entry for that package name, Node resolves inside the package directory the entry records; a hit returns, and a missing file inside the package continues per Node's own handling of a "found package": CommonJS keeps looking for the subpath layer by layer from ④, ESM fails immediately. If the runtime resolution has no entry, Node looks at the physical directory at ③ and then moves on to ④.

Node remains responsible for `exports`, `imports`, conditions, `main`, subpaths, extensions, caching, and error codes. When the selected package rejects a subpath through `exports`, the error is final; Node does not switch to another package of the same name.

The interception layer reads, writes, and deletes no disk links. Leftover historical symlinks are treated as ordinary filesystem content: the positions of installation package names at ③ are already occupied by the runtime resolution, so old links are never read; all other package names see the contents of ③ normally along the ancestor chain. Profile load removes, once, the projections the link backend of the dsh 0.1.5 releases wrote into a profile: symlinks under the profile's `node_modules` whose target lies inside `<profile>/.dsh-module-fallback/node_modules`, followed by that directory. pnpm-installed packages and every other symlink stay.

#### 3. Plugins linked outside the tree: interception at their real directory's `node_modules`

When `<profile>/node_modules/<package>` is a symlink whose real target R is outside the profiles tree, R is a linked root. Importers below R follow its real ancestor chain, with `R/node_modules` as the interception layer: deeper `node_modules` on that chain, such as a transitive dependency's own layer inside pnpm's `.pnpm/`, are local layers; above `R/node_modules`, Node continues through `parent(R)/node_modules` up to the filesystem root.

Only some package names are occupied at this layer: names declared in `R/package.json` under `peerDependencies` that also have a runtime resolution entry. A plugin declares dsh packages whose instances it must share with the host as peers. When lookup reaches this layer, the running dsh supplies the package, and the same-named devDependency copy installed at this position for type checking is not loaded. Names declared only under `dependencies`, not as peers, remain unoccupied. The plugin's own third-party versions retain Node's nearest-wins order, just as ① and ② precede ③ inside a profile.

Each resolution reads the peer set from `R/package.json`; runtime resolution construction does not freeze it, and linked importer routes are not memoized. After a developer changes `peerDependencies`, new resolutions during a plugin reload read the new declaration. This neither clears Node's module caches nor automatically watches plugin files. Names not occupied at this layer are delegated to Node from the `R/package.json` anchor: the physical contents of `R/node_modules`, followed by R's real ancestor chain. Runtime resolution construction scans top-level and `@scope/*` entries in `<profile>/node_modules` for linked roots. A successor may add or remove linked roots within the existing package-mapping and local-name constraints; changing the real target of an existing link name rejects publication and requires restart because Node caches real paths. An unreadable `R/package.json` occupies no names at this layer; Node reports its diagnostics.

#### 4. What the interception layer holds: the runtime resolution's scan contents

The runtime resolution is computed once at profile startup and consists of four parts.

- Installation closure: starting from the `package.json` of the currently running dsh package, a breadth-first traversal follows `dependencies` and `peerDependencies`; each edge resolves from the manifest that declares it per Node rules, and the first installed package found owns a package name. The closure holds several hundred entries, roughly half in the `@deepseek-ai/` scope and half third-party libraries. These entries apply to every profile.
- Bundle-only entries: for a bundle selected by the profile that is not part of the closure, the same traversal starts from its manifest, and package names the closure already owns are not overridden. These entries apply only to profiles that select that bundle; they let the Loader import the bundle's embedded plugins by bare name from the profile root.
- Local package names: package names among the profile's direct dependencies that are already installed in `$DSH_HOME/profiles/<name>/node_modules`. They already sit at ② on the ancestor chain; recording them only saves one directory probe.
- Linked roots: top-level and `@scope/*` symlinks in `$DSH_HOME/profiles/<name>/node_modules` whose targets are outside the profiles tree and contain a `package.json`; each records its real directory and link position. Links whose targets remain inside the profiles tree are not recorded because the ancestor chain already covers them.

The CLI derives the installation anchor from `import.meta.url`, which Node has already resolved to its real path; the Desktop Host builds it from its runtime directory, which is not a symlink. Both leave the installation root equal to its real directory, so bundle discovery and dependency traversal use the same location. During the traversal, every dependency level uses the real directory of its owning package as the lookup anchor for the next level and records the location of the manifest that declares it. After a hit, Node resolves from that declaring location and gets the same result the package's own internal imports get. Every entry records the package name, package directory, version, declaring location, and scope. Declared but uninstalled dependencies are skipped; the bundle package root itself does not become an entry.

#### 5. Hook coverage

The hook participates only when the importer is under `$DSH_HOME/profiles/**` or a linked root. Builtin, relative-path, absolute-path, and URL requests, and every request whose importer is outside both locations, go straight to Node.

The ESM and CommonJS adapters call the same routing function, and the main thread and Harness-owned Workers install the same runtime resolution. The implementation lives in `packages/boot/app-boot/src/profile-resolution/resolver.ts`; runtime resolution construction lives in `packages/boot/app-boot/src/profile.ts`.

### Part 2: Walkthroughs

#### Table 1: Ancestor chain and interception for ESM and CommonJS across request forms

The table uses the installation package `@deepseek-ai/dsh-tools` (has a runtime resolution entry) and the third-party library `left-pad` (no runtime resolution entry) as examples; `pkg` stands for either.

| Request form | ESM | CommonJS | Position of the package name at ③ | When a file is missing inside the package |
|---|---|---|---|---|
| Bare name `pkg`, package has `exports` | If ① or ② has a `pkg` directory, Node takes the entry point from its `exports` | Same as ESM; a candidate directory at ① or ② whose entry file is missing does not count as a candidate | With entry: the runtime resolution's package; without entry: the physical directory | A missing entry point under `exports` is an `exports` error, final |
| Bare name `pkg`, package has no `exports` | As above, entry point from `main` or `index` | As above | As above | ESM fails, final; CommonJS continues looking for an entry point at the next layer |
| Subpath `pkg/sub`, package has `exports` | The first `pkg` found decides; if `./sub` is not exported, `ERR_PACKAGE_PATH_NOT_EXPORTED` is final | Same as ESM | As above | Final; no other copy is searched |
| Subpath `pkg/sub`, package has no `exports` | If the first `pkg` found has no `sub`, `ERR_MODULE_NOT_FOUND` is final | Tries `<layer>/pkg/sub` layer by layer: ① and ②, then the position of the package name at ③ (the runtime resolution's package directory when an entry exists), then ④ | As above | ESM final; CommonJS continues to the next layer, that is ④ |
| `#alias` package-internal alias | After the owning manifest's `imports` maps it to a bare name, handled per the rows above; a mapping to a relative path goes straight to Node | Same as ESM, with conditions from the caller or the defaults | Same as the matching row | Same as the matching row |
| `require.resolve(pkg, { paths })` | No such form | Applies the same rule to each item in `paths` independently: an item inside the profile tree walks ① and ②, ③, ④ from that item; an item outside the tree goes to Node; in the caller's order | As above | The item continues to its next layer, then the next item takes its turn |
| Package self-reference (the importer's package imports by its own `name`) | Goes to Node with the original importer kept | Same as ESM | Not involved | Not applicable |
| Relative / absolute / URL / builtin | Goes to Node | Goes to Node | Not involved | Not applicable |

After a runtime resolution hit, the `ERR_MODULE_NOT_FOUND` and `ERR_PACKAGE_PATH_NOT_EXPORTED` errors Node reports replace the internal declaring location with the original importer; the CommonJS require stack also drops the internal anchor.

#### Table 2: Interception position for the Web and Desktop profiles

| profile | Directory | Interception layer | Difference from web |
|---|---|---|---|
| web | `$DSH_HOME/profiles/web` | `$DSH_HOME/profiles/node_modules` | Baseline |
| desktop | `$DSH_HOME/profiles/desktop` | `$DSH_HOME/profiles/node_modules` | None. Same tree, same layer; the Desktop Host runs the same resolver in Node mode |
| Out-of-tree profile | Any directory `loadProfileDirectory` accepts | The first ancestor `node_modules` above that directory | Same rule; no product currently uses an out-of-tree profile, only unit tests cover it |

#### Table 3: Ancestor chain when a plugin is linked outside the tree

The profile links `<profile>/node_modules/my-plugin` to the plugin's real directory R. R's manifest declares `@deepseek-ai/dsh-tools` as a peer and installs it as a devDependency, and declares `zod` as a dependency.

| Import source → target | Hook participates | Result |
|---|---|---|
| profile → linked plugin | Participates up to ② | Node follows the symlink at ②; the plugin loads by its real path |
| Linked plugin → `zod` | Participates; `zod` is not occupied at `R/node_modules` | `R/node_modules/zod`, the developer's installed version |
| Linked plugin → `@deepseek-ai/dsh-tools` (peer) | Participates; the name is occupied at `R/node_modules` | The running dsh's copy; the devDependency copy in `R/node_modules` is not read |
| Linked plugin → a stateful dsh package declared only as a dependency | Participates; the name is not occupied | Its own copy in `R/node_modules`, creating a second instance; the same mistake as installing the dsh package at ② inside the tree. Declare it as a peer instead |
| Linked plugin → undeclared package name | Participates; the name is not occupied | Physical contents of `R/node_modules`, then R's real ancestor chain |
| Transitive dependency inside R → any package name | Participates | Its own local layers first, then the rules above; the occupied set still comes from the peers in `R/package.json` |

### Part 3: Developer integration guide

#### 1. Normal installation

`dsh plugin --profile <name> add <package | git spec | file:../local-checkout>` forwards its argument to pnpm, which installs inside the profile directory with a hoisted layout. The profile's `pnpm-workspace.yaml` sets `autoInstallPeers: false`, so dsh packages a plugin declares as peers are not installed into the profile; the interception layer supplies the copy from the running installation, and the plugin and dsh share one module instance.

The plugin's own third-party dependencies are hoisted to `$DSH_HOME/profiles/<name>/node_modules` and found at ② on the ancestor chain. When a name collides with the installation closure, the nearest wins and the plugin uses the version it declared. The `file:` form copies the local checkout into the profile; resolution afterwards is identical to a registry installation.

#### 2. Development mode: the plugin repository is outside the profile tree

`npm link`, or a bare directory path such as `dsh plugin add ../my-plugin` (which pnpm treats as `link:`), makes the profile entry a symlink to the plugin repository, which becomes a linked root. The plugin loads by its real path and uses its own third-party dependencies. The interception layer at `R/node_modules` supplies dsh packages declared as peers from the running installation, whether dsh was installed globally from npm, bundled with Desktop, or started from the source repository. The dsh devDependency copy installed for type checking serves the compiler and is not read at runtime.

Use the same manifest declarations as the harness packages: declare dsh packages whose instances must be shared with the host under both `peerDependencies` and `devDependencies`. The peer declaration occupies their positions at `R/node_modules`; the dev copies serve the compiler and standalone tests. Keep third-party dependencies and stateless dsh utilities such as `@deepseek-ai/dsh-brand` and `@deepseek-ai/dsh-util-values` under `dependencies`. After changing `peerDependencies`, new resolutions during a plugin reload use the new declaration; Node and Cordis still own the lifetime of already loaded modules.

Two other layouts remain available: install `@deepseek-ai/dsh` in the plugin repository and run `pnpm exec dsh --profile <name>` there, or link dsh packages to a local source repository and start dsh from that repository. Both make the running dsh and the repository's copies identical, but linked plugins do not require either layout.

## Alternatives considered

**Let the runtime resolution act only as a fallback after the whole ancestor chain is exhausted.** The ancestor chain would first read a leftover historical installation link at ③ and use it, which conflicts with "installation packages come from the running installation". The runtime resolution must occupy the positions of installation package names at ③.

**Treat the runtime resolution as a whole layer inserted into the ancestor chain instead of occupying package directories at ③.** The two differ in exactly one place: when CommonJS hits a runtime resolution package and the subpath is missing, the former would go back and read the old copy of the same name at ③, while the latter goes straight to ④ per Node's handling of a "found package". Occupying the package directory matches Node semantics and needs no extra check for ③.

**Give installation closure entries absolute priority over nearer copies.** The closure contains 281 third-party libraries. A plugin's private versions of `zod`, `yaml`, and others would be overridden by the versions in the installation closure, breaking the nearest-wins rule shared with Node. The supported installation flow no longer installs dsh peers into the profile, so overriding is not needed to guarantee a single instance.

**Recognize and bypass symlinks in the `.dsh-module-fallback` layout at resolve time.** This keeps dedicated logic in the lookup path for directories that are no longer produced, and every resolution pays for it. Removing those projections once at profile load reaches the same result: after a bundle is deselected while it stays installed, its projected plugin no longer shadows the same-named plugin the runtime resolution selects from another bundle.

**Hide the whole physical directory that holds the interception layer.** This conflicts with "all other resolution matches Node": non-installation packages placed in `$DSH_HOME/profiles/node_modules` would become invisible to every profile.

**Let every runtime resolution entry occupy its package directory at `R/node_modules`.** This has exactly the same form as ③, but the closure's hundreds of third-party libraries would shadow the plugin repository's own `zod` and `yaml` versions, unlike ① and ② preceding ③ inside the tree. Occupying only peers preserves the plugin's own third-party versions.

**Use the nearest importer's manifest `dependencies` to decide which names resolve natively.** This can simulate an installation into the profile without devDependencies or peers, but every resolution must find the importer's nearest manifest, and the rule differs from ③. Occupying peers reads only the linked root's manifest.

**Freeze the peer set during runtime resolution construction.** Every edit to `peerDependencies` would require restarting dsh. Reading at resolution time makes plugin reloads sufficient, at the cost of one small-file read per routed request in development mode.

**Connect the ancestor chain above the linked root back to the profile's ② and ③.** This follows the form of Node's `--preserve-symlinks`: `R/node_modules` remains the first native layer, so the devDependency copy still wins and the duplicate-instance problem remains.

## Verification

- The table-driven matrix in [profile-resolution.spec.ts](../../../../packages/boot/app-boot/tests/profile-resolution.spec.ts): importers are the profile root and a plugin inside the profile; package names are an installation entry, a bundle-only entry, and a name outside the table; every presence combination of the four layers ①②③④, with ② and ③ each in two forms, a real directory and a symlink pointing elsewhere; every cell asserts that ESM import, CommonJS require, `require.resolve`, and the `packageDir` metadata land in the same directory.
- Linked-root cases in the same file link a profile package to an external repository with a same-named devDependency copy in its `node_modules`. Package names cover an installation entry declared as a peer, one declared as a dependency, the repository's own third-party dependency, and an undeclared name; importers cover the repository's own files and transitive dependencies inside it. The cases assert agreement across the four resolution forms, that the devDependency copy is not read, and that the next resolution observes a rewritten `peerDependencies` declaration.
- Dedicated cases in the same file cover each row of Table 1: bare names and subpaths with and without `exports`, `#alias`, explicit `paths`, package self-reference, CommonJS skipping ③ and going straight to ④ when a subpath is missing after a runtime resolution hit, and the interception position of an out-of-tree profile.
- The [real CLI launch test](../../../../apps/cli/tests/profiles/headless/tests/profile-resolution.ts), under src and lib launches and under plain-directory and npm-link layouts, places an old `@deepseek-ai/dsh-tools` link at ③ and an external package with its embedded dependency at ③. The npm-link layout also gives the linked plugin a `@deepseek-ai/dsh-tools` devDependency copy and declares it as a peer. It asserts that Tools and AgentLoop share one module instance, that the linked plugin receives that same Tools instance, that the external package resolves along its real path, and that every file and link target stays byte-identical.

## Consequences

Gained: module resolution needs no disk projections; dsh installation packages selected at an interception layer come from the running installation, including peers declared by plugins linked outside the tree; other resolution retains Node's ancestor-chain and package-entry rules; the lookup path does not recognize historical projection directories.

Paid: third-party libraries in the installation closure still occupy package directories at ③, so a profile plugin that declares a third-party library as a peer or omits the declaration gets the version dsh uses internally, as in the disk-link era; plugins should declare third-party libraries as dependencies. A linked plugin receives dsh packages from the running installation only when it declares them as peers; dependency declarations retain its own copies. Only direct symlinks from `<profile>/node_modules` become linked roots; dependencies linked elsewhere from the plugin repository or hoisted outside it by npm workspaces remain outside every linked root and use plain Node resolution. Peer requests for other plugins inside the profile do not return to ② and fail if R's real ancestor chain cannot find them. Each routed request in development mode reads the plugin manifest. Changing a link target at the same logical path still requires restart. Consumers that bypass the hook, namely child processes a plugin spawns itself, third-party Workers, and external tools run inside the profile directory, can no longer find installation packages through disk links in `$DSH_HOME/profiles/node_modules`. The resolver continues to depend on supported Node Internal interfaces.
