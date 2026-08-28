# 权限预设

[English](permission-presets.md) | 中文

[dsh-permission-presets](../../packages/interaction/permission-presets) 的权限预设层（`ctx.permissionPresets`，`PermissionPresetService`）把两个相互独立的强制执行 knob，即[沙箱模式](sandbox.zh.md)（`sandbox/mode`）与[审批策略](approval.zh.md)（`approval/policy`），捆绑成具名预设，供客户端作为单个 Permissions 选择器提供。配置表拥有未来会话默认值，而受 effect 作用域约束的 integration 可以贡献一个带同步准入检查、仅限当前会话的预设。该层是可选能力，且不拥有执行策略：提示词叙述与回放仍读取各自 knob 的折叠结果，任何额外强制执行则由 [Auto review](../../packages/interaction/auto-review/README.zh.md) 这类 contribution 拥有。[包 README](../../packages/interaction/permission-presets/README.zh.md)负责组合状态与限制；[沙箱切换设计](../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)负责原始旋钮依据。

源码：[`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)

## 预设表

预设把一个稳定 key 映射到一组沙箱／审批组合，外加可选的客户端展示信息。默认配置表自带 `workspace-write`（`workspace-write` + `ask`）和 `danger-full-access`（`danger-full-access` + `never`）；`custom` 与 `auto` 是保留名称，不能配置。

```ts type-equiv
/** One preset's sandbox/approval bundle and optional client presentation. */
interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}
```

```ts type-equiv
/** The {@link PermissionPresetService} config: preset table and composition default. */
interface Config {
  /**
   * The preset table: name → knob bundle. Defaults to `workspace-write`
   * (workspace-write + ask) and `danger-full-access` (danger-full-access +
   * never). The names `custom` and `auto` are reserved for derived state and
   * the Auto review integration respectively.
   */
  presets?: Record<string, PresetSpec>
  /**
   * Default for new sessions. When omitted, the preset matching the composed
   * sandbox and approval defaults is used.
   */
  defaultPreset?: string
}
```

该服务要求一个施加隔离的 `ctx.shell` 执行器和 `ctx.approval`，配置错误在插件加载时即失败：名为 `custom` 或 `auto` 的配置条目会抛出异常；在不施加隔离的 bash 执行器（没有 `sandboxMode` 能力事实）之上组合同样抛出异常，因为预设捆绑了一个沙箱模式。

## 当前会话 contribution

integration 会在自身 effect 生命周期内注册一个 contribution。contribution 按注册顺序排列在配置预设之后，绝不会进入 `permission.defaultPreset` 设置 schema，并在 effect dispose 时消失。同步 `admit` 回调会在选择动作修改 Session 之前运行。保留的 Auto 身份还要求其 live contribution 存在，并在存储的 Auto Session 发布前通过准入，因此 integration 缺失或正在关闭时不会改写持久身份。

```ts type-equiv
/** One effect-scoped current-session preset supplied by an integration. */
interface PermissionPresetContribution {
  /** Canonical preset name recorded in `permission/preset`. */
  readonly name: string
  /** Sandbox and approval values written by the normal preset path. */
  readonly spec: PresetSpec
  /**
   * Synchronously admit one live selection. The reserved Auto contribution is
   * also called before a stored Auto session publishes. Throwing leaves the
   * session unchanged or vetoes Auto publication.
   * @param session - session selecting this contribution or restoring Auto.
   */
  readonly admit: (session: Session) => void
}
```

## 当前预设与派生的 `custom`

`current(events)` 从 knob 派生实际生效的预设，而不是只看自身事件：它折叠会话的生效沙箱模式（回退到执行器配置的模式）与生效审批策略（先回退到审批服务配置，再回退到 `ask`），优先取仍然匹配的已记录选择，其次取第一个匹配的配置条目，再取第一个匹配的 live contribution，否则返回 `CUSTOM_PRESET`（`'custom'`）。`custom` 只是派生值：客户端可以把它显示为当前值，但它绝不是切换目标，也绝不出现在事件 payload 中。

`names` 先按声明顺序列出配置预设，再按注册顺序列出 live contribution。`optionOf(name)` 为可用 key（label 回退为该 key）或 `custom` 构建客户端渲染的选项，传入其他任何名称都会抛出异常。

```ts type-equiv
/** The select-option shape a presentation layer advertises for one preset (or for the derived `custom` state). */
interface PresetOption {
  /** Stable option value: the table key, or `custom`. */
  value: string
  /** The display label. */
  name: string
  /** One user-facing sentence on what the value means; omitted when not configured. */
  description?: string
}
```

## 切换与 `permission/preset` 事件

`set(session, name)` 解析预设（未知名称抛出异常），在适用时运行 contribution 的准入回调，在 `name` 尚不是生效预设时追加一条仅记日志的 `permission/preset` 事件，然后通过各旋钮自己的 setter（[dsh-sandbox-policy](../../packages/sandbox/sandbox-policy) 的 `setSandboxMode` 与 [dsh-user-approval](../../packages/interaction/user-approval) 的 `setApprovalPolicy`）写入，且仅当该 knob 的生效值发生变化时才写。同一轮次内，选择事件先于旋钮事件出现；重新选择当前生效的预设则什么都不追加。

`permission/preset` 是持久、仅记日志的用户意图：它不进入模型 transcript（文本记录），并让 `current()` 在两个预设共享同一旋钮组合时仍能保留用户究竟选择了哪一个。`effectivePermissionPreset(events)` 折叠最后一条，回放不需要任何追赶状态，而恢复的 `auto` 选择在 agent 发布前必须存在 Auto contribution。完整事件声明见[持久化日志事件目录](../persistence-catalog.zh.md)；方法签名见生成的[服务目录](#ctxpermissionpresets--permissionpresetservice)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpermissionpresets--permissionpresetservice"></a>

### `ctx.permissionPresets` — `PermissionPresetService`

Owns the deployment's configured and contributed permission presets and their write path. Requires a confining `ctx.shell` executor and `ctx.approval`; unmatched knob values are reported as CUSTOM_PRESET, not an error.

```ts cordis-catalog
/**
 * Register one current-session-only preset for the calling integration's
 * effect lifetime.
 * @param contribution - preset identity, knob bundle, and synchronous admission gate.
 * @returns the async effect disposer that removes exactly this contribution.
 */
register(contribution: PermissionPresetContribution): () => Promise<void>

/**
 * Resolve the preset matching the effective knob values. A still-matching
 * last selection wins shared-bundle ties; otherwise the first configured
 * match, then the first contributed match, wins. Returns
 * {@link CUSTOM_PRESET} when no available preset matches.
 * @param events - the session's events in log order.
 * @returns the effective preset name, or `custom` when nothing matches.
 */
current(events: readonly SessionEvent[]): string

/**
 * Build the whole select value for one folded knob state: configured options
 * in declaration order, live contributions in registration order, and
 * `custom` appended exactly while derived.
 * @param state - the folded knob overrides.
 * @returns the `permissions` projection payload.
 */
selectFor(state: KnobState): PermissionSelect

/**
 * Resolve an available preset's knob bundle.
 * @param name - the preset name to resolve.
 * @returns the configured bundle.
 * @throws when `name` is neither configured nor currently contributed.
 */
resolve(name: string): PresetSpec

/**
 * Build the client option for an available preset or {@link CUSTOM_PRESET}.
 * A missing label falls back to the preset key.
 * @param name - a configured or contributed preset key, or `custom`.
 * @returns the option a client renders.
 * @throws when `name` is neither a table key nor `custom`.
 */
optionOf(name: string): PresetOption

/**
 * Record a changed preset, then update each changed knob through its own
 * setter. Selecting the effective preset again appends nothing.
 * @param session - the session the switch belongs to.
 * @param name - the preset to switch to; unknown names throw.
 */
set(session: Session, name: string): void
```

Types: [Session](session.zh.md) · [SessionEvent](session.zh.md)

Source: [`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)
<!-- END GENERATED cordis-surface -->
