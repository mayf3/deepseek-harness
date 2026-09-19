# Agent Note: Resolve profile modules along the ancestor chain with an interception layer

Status: implemented

English | [中文](2026-09-19-profile-resolution-lookup-order.zh.md)

## Problem

A profile loads plugins from its own package project. The dsh installation packages and the dependencies embedded in bundles are not on the profile's dependency tree, so Node's default `node_modules` lookup starting from the profile cannot find them.

A developer must be able to restate the resolution rule in one sentence: which part is ordinary Node behavior, which part is dsh's intervention, and where that intervention ends. The previous runtime implementation hid the whole `$DSH_HOME/profiles/node_modules` layer for every package name and kept dedicated recognition code for historical directory layouts, so the rule could not be stated in one sentence and nobody could judge whether a given resolution result was expected.

## Decision

Module resolution inside a profile is an ordinary Node ancestor `node_modules` chain. dsh does exactly one thing: every package name in the generation computed at startup occupies the package directory position `$DSH_HOME/profiles/node_modules/<package>`. When the chain reaches this layer, a package name with an entry is answered by the generation's package, and a package name without an entry sees the physical directory at this layer. Every other resolution behavior matches Node. [Construction, publication, Worker inheritance, and runtime carriers of immutable generations](2026-09-09-profile-resolution-generations.md) are recorded by the existing Note and are not repeated here.

### Part 1: Resolution rules

#### 1. The ancestor chain: Node's ancestor `node_modules` lookup

The importer is the module file that issues the `import` or `require`. Node starts from the importer's directory, tries the `node_modules` under each directory level upward until the filesystem root, and then tries `NODE_PATH` and the global directories. The nearest layer wins; within one layer, matching is by package name only.

Symlinks are followed to their real path per Node's default behavior. Once a module is loaded by its real path, the ancestor chain for its subsequent imports is the real path's ancestor chain, regardless of where it was linked from.

The chain below defines the numbering that every table in this Note references. The importer is `$DSH_HOME/profiles/web/node_modules/my-plugin/index.js`:

```text
① $DSH_HOME/profiles/web/node_modules/my-plugin/node_modules   插件私有依赖
② $DSH_HOME/profiles/web/node_modules                          profile 安装的包
③ $DSH_HOME/profiles/node_modules                              拦截层：generation 占据其中有条目的包目录
④ $DSH_HOME/node_modules
⑤ /node_modules，随后是 NODE_PATH 与全局目录
```

#### 2. The interception layer: the generation occupies `$DSH_HOME/profiles/node_modules/<package>`

The interception layer is the first ancestor `node_modules` above the importer's profile directory (`$DSH_HOME/profiles/<name>`). For every profile inside the tree this layer is `$DSH_HOME/profiles/node_modules`.

Every package name in the generation occupies the package directory position `<interception layer>/<package>` at this layer. For an installation package name such as `@deepseek-ai/dsh-tools`, the package directory at ③ is the copy of the running installation; an old link or old directory of the same name on disk is no longer a member of the chain. For a package name absent from the generation, the package directory at ③ is the physical content on disk.

The order for one bare package name request: the ancestor chain first walks the layers inside the profile directory (① and ②), and when a candidate exists Node resolves inside that candidate and returns. On reaching ③, if the generation has an entry for that package name, Node resolves inside the package directory the entry records; a hit returns, and a missing file inside the package continues per Node's own handling of a "found package": CommonJS keeps looking for the subpath layer by layer from ④, ESM fails immediately. If the generation has no entry, Node looks at the physical directory at ③ and then moves on to ④.

Node remains responsible for `exports`, `imports`, conditions, `main`, subpaths, extensions, caching, and error codes. When the selected package rejects a subpath through `exports`, the error is final; Node does not switch to another package of the same name.

The interception layer reads, writes, and deletes no disk links. Leftover historical symlinks are treated as ordinary filesystem content: the positions of installation package names at ③ are already occupied by the generation, so old links are never read; all other package names see the contents of ③ normally along the ancestor chain. Profile load removes, once, the projections the link backend of the dsh 0.1.5 releases wrote into a profile: symlinks under the profile's `node_modules` whose target lies inside `<profile>/.dsh-module-fallback/node_modules`, followed by that directory. pnpm-installed packages and every other symlink stay.

#### 3. What the interception layer holds: the generation's scan contents

The generation is computed once at profile startup and consists of three parts.

- Installation closure: starting from the `package.json` of the currently running dsh package, a breadth-first traversal follows `dependencies` and `peerDependencies`; each edge resolves from the manifest that declares it per Node rules, and the first installed package found owns a package name. The current source tree measures 539 entries, of which 258 are in the `@deepseek-ai/` scope and 281 are third-party libraries. These entries apply to every profile.
- Bundle-only entries: for a bundle selected by the profile that is not part of the closure, the same traversal starts from its manifest, and package names the closure already owns are not overridden. These entries apply only to profiles that select that bundle; they let the Loader import the bundle's embedded plugins by bare name from the profile root.
- Local package names: package names among the profile's direct dependencies that are already installed in `$DSH_HOME/profiles/<name>/node_modules`. They already sit at ② on the ancestor chain; recording them only saves one directory probe.

During the traversal, every dependency level uses the real directory of its owning package as the lookup anchor for the next level and records the location of the manifest that declares it. After a hit, Node resolves from that declaring location and gets the same result the package's own internal imports get. Every entry records the package name, package directory, version, declaring location, and scope. Declared but uninstalled dependencies are skipped; the bundle package root itself does not become an entry.

#### 4. Hook coverage

The hook participates only when the importer is under `$DSH_HOME/profiles/**`. Builtin, relative-path, absolute-path, and URL requests, and every request whose importer is outside the tree, go straight to Node.

The ESM and CommonJS adapters call the same routing function, and the main thread and Harness-owned Workers install the same generation. The implementation lives in `packages/boot/app-boot/src/profile-resolution/resolver.ts`; generation construction lives in `packages/boot/app-boot/src/profile.ts`.

### Part 2: Walkthroughs

#### Table 1: Ancestor chain and interception for ESM and CommonJS across request forms

The table uses the installation package `@deepseek-ai/dsh-tools` (has a generation entry) and the third-party library `left-pad` (no generation entry) as examples; `pkg` stands for either.

| Request form | ESM | CommonJS | Position of the package name at ③ | When a file is missing inside the package |
|---|---|---|---|---|
| Bare name `pkg`, package has `exports` | If ① or ② has a `pkg` directory, Node takes the entry point from its `exports` | Same as ESM; a candidate directory at ① or ② whose entry file is missing does not count as a candidate | With entry: the generation's package; without entry: the physical directory | A missing entry point under `exports` is an `exports` error, final |
| Bare name `pkg`, package has no `exports` | As above, entry point from `main` or `index` | As above | As above | ESM fails, final; CommonJS continues looking for an entry point at the next layer |
| Subpath `pkg/sub`, package has `exports` | The first `pkg` found decides; if `./sub` is not exported, `ERR_PACKAGE_PATH_NOT_EXPORTED` is final | Same as ESM | As above | Final; no other copy is searched |
| Subpath `pkg/sub`, package has no `exports` | If the first `pkg` found has no `sub`, `ERR_MODULE_NOT_FOUND` is final | Tries `<layer>/pkg/sub` layer by layer: ① and ②, then the position of the package name at ③ (the generation's package directory when an entry exists), then ④ | As above | ESM final; CommonJS continues to the next layer, that is ④ |
| `#alias` package-internal alias | After the owning manifest's `imports` maps it to a bare name, handled per the rows above; a mapping to a relative path goes straight to Node | Same as ESM, with conditions from the caller or the defaults | Same as the matching row | Same as the matching row |
| `require.resolve(pkg, { paths })` | No such form | Applies the same rule to each item in `paths` independently: an item inside the profile tree walks ① and ②, ③, ④ from that item; an item outside the tree goes to Node; in the caller's order | As above | The item continues to its next layer, then the next item takes its turn |
| Package self-reference (the importer's package imports by its own `name`) | Goes to Node with the original importer kept | Same as ESM | Not involved | Not applicable |
| Relative / absolute / URL / builtin | Goes to Node | Goes to Node | Not involved | Not applicable |

After a generation hit, the `ERR_MODULE_NOT_FOUND` and `ERR_PACKAGE_PATH_NOT_EXPORTED` errors Node reports replace the internal declaring location with the original importer; the CommonJS require stack also drops the internal anchor.

#### Table 2: Interception position for the Web and Desktop profiles

| profile | Directory | Interception layer | Difference from web |
|---|---|---|---|
| web | `$DSH_HOME/profiles/web` | `$DSH_HOME/profiles/node_modules` | Baseline |
| desktop | `$DSH_HOME/profiles/desktop` | `$DSH_HOME/profiles/node_modules` | None. Same tree, same layer; the Desktop Host runs the same resolver in Node mode |
| Out-of-tree profile | Any directory `loadProfileDirectory` accepts | The first ancestor `node_modules` above that directory | Same rule; no product currently uses an out-of-tree profile, only unit tests cover it |

#### Table 3: Ancestor chain when a plugin is linked outside the tree

| Import source → target | Hook participates | Result |
|---|---|---|
| profile → linked plugin | Participates up to ② | Node follows the symlink at ②; the plugin loads by its real path |
| Linked plugin → its own third-party dependencies | Does not participate | The real path's ancestor chain; uses the version in the developer's own `node_modules` |
| Linked plugin → dsh installation packages | Does not participate | The copy in the developer's own `node_modules`; `ERR_MODULE_NOT_FOUND` when absent. Part 3 describes how to make it the same copy as the running dsh |

### Part 3: Developer integration guide

#### 1. Normal installation

`dsh plugin --profile <name> add <package | git spec | file:../local-checkout>` forwards its argument to pnpm, which installs inside the profile directory with a hoisted layout. The profile's `pnpm-workspace.yaml` sets `autoInstallPeers: false`, so dsh packages a plugin declares as peers are not installed into the profile; the interception layer supplies the copy from the running installation, and the plugin and dsh share one module instance.

The plugin's own third-party dependencies are hoisted to `$DSH_HOME/profiles/<name>/node_modules` and found at ② on the ancestor chain. When a name collides with the installation closure, the nearest wins and the plugin uses the version it declared. The `file:` form copies the local checkout into the profile; resolution afterwards is identical to a registry installation.

#### 2. Development mode: the plugin repository is outside the profile tree

`npm link`, or a bare directory path such as `dsh plugin add ../my-plugin` (which pnpm treats as `link:`), makes the entry in the profile a symlink to the plugin repository. The plugin loads by its real path and the hook takes no part in its imports. The plugin repository's own dependency tree must resolve dsh installation packages to the same copy as the running dsh; both layouts below satisfy this.

- Layout A: the plugin repository installs `@deepseek-ai/dsh` and the `@deepseek-ai/dsh-*` peers the plugin uses as devDependencies and starts with the dsh in that repository, for example `pnpm exec dsh --profile <name>`. The running installation is the copy on the plugin's ancestor chain, so the generation and the real paths agree.
- Layout B: the plugin repository links the dsh packages it uses to the local dsh source repository (`link:../deepseek-harness/packages/core/tools` or `pnpm link`) and starts `pnpm dsh --profile <name>` from the source repository. Both sides load the same copy from the source repository.

Not provided and not recommended: having the hook proxy installation packages for real paths linked out of the tree, which requires tracking every real root entered from the profile, something Node itself does not do for developers either; and starting with a dsh installed elsewhere while the plugin repository installs its own dsh devDependencies, which produces two module instances and splits both `Symbol()` keys and `instanceof` checks.

## Alternatives considered

**Let the generation act only as a fallback after the whole ancestor chain is exhausted.** The ancestor chain would first read a leftover historical installation link at ③ and use it, which conflicts with "installation packages come from the running installation". The generation must occupy the positions of installation package names at ③.

**Treat the generation as a whole layer inserted into the ancestor chain instead of occupying package directories at ③.** The two differ in exactly one place: when CommonJS hits a generation package and the subpath is missing, the former would go back and read the old copy of the same name at ③, while the latter goes straight to ④ per Node's handling of a "found package". Occupying the package directory matches Node semantics and needs no extra check for ③.

**Give installation closure entries absolute priority over nearer copies.** The closure contains 281 third-party libraries. A plugin's private versions of `zod`, `yaml`, and others would be overridden by the versions in the installation closure, breaking the nearest-wins rule shared with Node. The supported installation flow no longer installs dsh peers into the profile, so overriding is not needed to guarantee a single instance.

**Recognize and bypass symlinks in the `.dsh-module-fallback` layout at resolve time.** This keeps dedicated logic in the lookup path for directories that are no longer produced, and every resolution pays for it. Removing those projections once at profile load reaches the same result: after a bundle is deselected while it stays installed, its projected plugin no longer shadows the same-named plugin the generation selects from another bundle.

**Hide the whole physical directory that holds the interception layer.** This conflicts with "all other resolution matches Node": non-installation packages placed in `$DSH_HOME/profiles/node_modules` would become invisible to every profile.

**Extend the hook to the real directories of plugins linked outside the tree.** This requires tracking every real root entered from the profile during resolution and rewriting results for some package names under those directories; Node does this for no linked-out package, and the two layouts in Part 3 do not need it.

## Verification

- The table-driven matrix in [profile-resolution.spec.ts](../../../../packages/boot/app-boot/tests/profile-resolution.spec.ts): importers are the profile root and a plugin inside the profile; package names are an installation entry, a bundle-only entry, and a name outside the table; every presence combination of the four layers ①②③④, with ② and ③ each in two forms, a real directory and a symlink pointing elsewhere; every cell asserts that ESM import, CommonJS require, `require.resolve`, and the `packageDir` metadata land in the same directory.
- Dedicated cases in the same file cover each row of Table 1: bare names and subpaths with and without `exports`, `#alias`, explicit `paths`, package self-reference, CommonJS skipping ③ and going straight to ④ when a subpath is missing after a generation hit, and the interception position of an out-of-tree profile.
- The [real CLI launch test](../../../../apps/cli/tests/profiles/headless/tests/profile-resolution.ts), under src and lib launches and under plain-directory and npm-link layouts, places an old `@deepseek-ai/dsh-tools` link at ③ and an external package with its embedded dependency at ③, and asserts that Tools and AgentLoop share one module instance, that the external package resolves along its real path, and that every file and link target stays byte-identical.

## Consequences

Gained: startup writes nothing to disk; installation packages always come from the running installation; all other resolution matches Node, so developers can predict results with their Node knowledge; no recognition code exists for any historical directory layout.

Paid: third-party libraries in the installation closure still occupy package directories at ③, so a profile plugin that declares a third-party library as a peer or omits the declaration gets the version dsh uses internally, as in the disk-link era; plugins should declare third-party libraries as dependencies. Plugins linked outside the tree cannot obtain installation packages through the hook and must align themselves using the layouts in Part 3. Consumers that bypass the hook, namely child processes a plugin spawns itself, third-party Workers, and external tools run inside the profile directory, can no longer find installation packages through disk links in `$DSH_HOME/profiles/node_modules`. The resolver continues to depend on supported Node Internal interfaces.
