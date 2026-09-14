# Profile 管理

[English](boot.md) | 中文

[boot 包组](../../packages/boot/README.zh.md)负责 launcher 提供的 profile 访问与插件管理器。[插件管理器](../../packages/boot/plugin-manager/README.zh.md)文档说明持久化、重载与包操作行为。

## 管理记录

`PluginEntryId` 标识一个 Loader 条目；调用方从 `listPlugins` 获取，不自行拼接 patch id。

`PluginInfo` 包含模块标识、实际启停状态和 fiber 阶段，以及唯一的 `patchId` 或 `readOnlyReason`。

`BundleInfo` 包含包名、可选的安装版本、组合层选择状态、删除可用性及可选的解析错误。

`InstallBundleOptions.enabled` 默认为 true。False 表示安装但不选择该组合包层。

`ChangeResult.changed` 独立报告磁盘修改，`application` 为 `applied`、`restart-required`、`overridden` 或 `failed`。`message` 描述结果。可选的 `packageResult` 记录 pnpm 退出码、有界输出、截断标记与完整诊断日志路径。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpluginmanager--pluginmanager"></a>

### `ctx.pluginManager` — `PluginManager`

Manage profile files and apply their declared reload lifecycle.

```ts cordis-catalog
/** Read current plugins, including why a row cannot be changed through the profile patch.
 * @returns Current runtime entries with persistent patch targets.
 */
@Remote async listPlugins(): Promise<PluginInfo[]>

/** Read installed bundles and bundles supplied by this dsh installation.
 * @returns Package versions, activation selections and removal availability.
 */
@Remote listBundles(): Promise<BundleInfo[]>

/** Persist a plugin entry's desired enablement and apply it on live profiles.
 * @param id Loader entry identity returned by listPlugins.
 * @param enabled Whether the plugin should run.
 * @returns Saved and runtime outcomes, including higher-priority overrides.
 */
@Remote setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult>

/** Select or remove a bundle layer while retaining installed dependencies.
 * @param name Bundle package name.
 * @param enabled Whether the bundle contributes its patch layer.
 * @returns Persisted and runtime outcomes.
 */
@Remote setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>

/** Install a package using the same pnpm implementation as dsh plugin.
 * @param spec One package spec, including local paths relative to the invocation directory.
 * @param options Whether to activate the installed bundle; defaults to true.
 * @returns Package-manager diagnostics and observed activation outcome.
 */
@Remote installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult>

/** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path.
 * @param name Installed dependency name.
 * @returns Removal diagnostics and the remaining profile state.
 */
@Remote removeBundle(name: string): Promise<ChangeResult>
```

Source: [`packages/boot/plugin-manager/src/index.ts`](../../packages/boot/plugin-manager/src/index.ts)

<a id="ctxprofileruntime--profileruntime"></a>

### `ctx.profileRuntime` — `ProfileRuntime`

Current-process profile operations; callbacks run under the shared profile write lock.

```ts cordis-catalog
/** Read the current manifest and bundle patch layers without initializing a profile.
 * @returns Resolved disk configuration.
 */
read(): Profile

/** Compose disk configuration with the invocation's higher-priority layers.
 * @returns Effective entry options in composition order.
 */
entries(): EntryOptions[]

/** Serialize a mutation with file watching and other profile writers.
 * @param operation Work performed while holding the profile manifest lock.
 * @param waitMs Maximum lock acquisition time; omission uses the file writer default.
 * @returns The operation's result.
 */
mutate<T>(operation: () => Promise<T>, waitMs?: number): Promise<T>

/** Apply the current disk configuration; call only inside mutate. */
reload(): Promise<void>
```

Source: [`packages/boot/app-boot/src/profile-runtime.ts`](../../packages/boot/app-boot/src/profile-runtime.ts)
<!-- END GENERATED cordis-surface -->
