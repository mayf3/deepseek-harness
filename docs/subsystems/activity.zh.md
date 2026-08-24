# 实时活动观察

[English](activity.md) | 中文

流式输出生产者、`ctx.activities` 与观察消费者共享的类型。设计归[观察 seam Agent Note](../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.zh.md)所有；本页记录 [`packages/activity/activity/src/types.ts`](../../packages/activity/activity/src/types.ts) 的跨包词汇与 [`packages/api/activity-controller/src/types.ts`](../../packages/api/activity-controller/src/types.ts) 的 wire 帧。

**activity** 是一个可观察的长时工作单元：一条 append-only 的有界输出流加实时状态。注册表是纯观察面——不启动、不取消任何工作，对模型不可见。生产者保留自己的执行资源与模型面（`ctx.jobs` 消费游标、工具结果）；观察者按绝对字节 offset 非消费读取，任意数量的观察者可与模型的单一消费游标共存。

## Id、kind 与关联

`ActivityId` 是[品牌化 id](core.zh.md#branded-ids)，生成为 `<kind>-N`；可见性靠 owner 授权而非 id 保密。`ActivityKindMap` 可合并扩展（内置 `bash`；`pwsh` 与 `workflow` 由各自生产者合并）。`ActivityCorrelation` 把一个 activity 关联到发起工作的 `CallId` 与承载其模型控制面的 `JobId`，消费者据此把流挂到已有卡片或行上，不必靠 label 猜。

## 生产者面

`open(spec)` 返回 `ActivityHandle`：同步的 `append(text, { channel?, gapBefore? })`、`updateDetail(detail)` 与 first-wins 的 `end(outcome)`。offset 按每个 chunk 的 UTF-8 字节长度推进；`gapBefore` 标记生产者侧丢失，让断点保持可见。`end` 之后——包括 teardown 强制 end——`append` 与 `updateDetail` 记日志后丢弃而不抛错，生产者的收尾 flush 不会砸掉自己的 teardown。

`pumpActivityOutput(handle, sources, { pollMs, done })` 适配 pull 型底座：把每个非消费 offset 读取器（subprocess 的 `readFrom(fromByte)` 家族，经 `ShellProcess.observed` 复出）按有界节奏复制进句柄，并在 `done` 结算后再排干一次。push 天然的生产者（workflow 工具的运行镜像）直接 append。

## 观察

`read(id, from, caller?)` 返回与 `[from, total)` 重叠的保留 chunk 及续读 offset `next`，绝不消费。offset 跨淘汰稳定：快照上的 `outputEarliest` 指明最老保留字节，低于它的读取得到 `lossy: true` 而非错误。保留量是 provider 策略（[`dsh-activity-local`](../../packages/activity/activity-local/README.zh.md)：存活 `retainBytes`，结算时裁到 `settledRetainBytes`）。

两个 effect 范围的监听族按 jobs 注册表条款做 owner 相对投递：`onActivitiesChanged` 在每次可见集变化（开启、detail、结算、移除）时触发，消费者整读行；`onOutput` 发出流推进信号（append 或结算），只带 id，各消费者按自己的游标读取。

## Wire 传输

[`dsh-api-activity-controller`](../../packages/api/activity-controller/README.zh.md) 以两条 Remote 流把观察面暴露给浏览器：`activity.control`（baseline + 整桶 roster 替换帧）与 `activity.observe`（一帧 `opened` 锚点、合并的 `output` 帧、同流的终态 `status`，之后本代关闭）。输出帧是瞬态的——持久历史仍在生产者的工具结果里，与 [web job display 决策](../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.zh.md)的要求一致。[`dsh-client-ui-activity`](../../packages/client/ui-activity/README.zh.md) 在会话头部渲染 roster，只在面板展开时打开观察流。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxactivities--activityregistry-abstract-seam"></a>

### `ctx.activities` — `ActivityRegistry` (abstract seam)

Abstract streaming-output registry. Subclass, implement the abstract methods, and load the subclass as a plugin — it registers as `ctx.activities` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Observation never consumes. Any number of readers hold their own absolute byte offsets; a read changes no cursor and no producer state, so the model-facing paths (`ctx.jobs.read()`, tool results) are unaffected.
- Records outlive producer fibers. Owner disposal ends still-open records and removes them; service disposal ends and clears everything. Neither awaits a producer — the registry owns no execution resource.
- Retention is bounded. Appends past the live cap drop the oldest retained bytes; a reader below the retained window gets a lossy read, never an error. Settlement trims retention to the settled cap.
- Listener delivery is owner-relative: a listener registered from an unscoped context — a host composition's own carrier — sees every owner, while one registered under an agent composition's scope sees exactly the agents composed under it. Every listener is contained.

```ts cordis-catalog
/**
 * Validate the spec, attach owner cleanup, and atomically register one
 * activity. A rejection leaves no id; after return the producer owns the
 * handle and the visible set has changed.
 * @param spec - activity identity, owner, and correlation.
 * @returns the producer face of the registered activity.
 */
abstract open(spec: ActivityOpen): ActivityHandle

/**
 * List caller-owned and unowned activities in registration order without
 * exposing another session's labels or output.
 * @param caller - reading agent; a non-agent caller sees only unowned activities.
 * @returns fresh snapshots.
 */
abstract list(caller?: Agent): ActivitySnapshot[]

/**
 * Return a fresh snapshot. Throws for an unknown or foreign activity.
 * @param id - activity to look up.
 * @param caller - reading agent checked against the owner.
 * @returns a fresh snapshot.
 */
abstract get(id: ActivityId, caller?: Agent): ActivitySnapshot

/**
 * Read retained output from an absolute byte offset without consuming it.
 * Resume by passing a previous read's `next`; a foreign offset inside a
 * retained chunk returns that whole chunk (its `at` may precede `from`).
 * Throws for an unknown or foreign activity or a negative or non-integer
 * offset.
 * @param id - activity to read.
 * @param from - absolute byte offset to read from (0 for the retained head).
 * @param caller - reading agent checked against the owner.
 * @returns retained chunks overlapping `[from, total)`, the resume offset, and the lossy flag.
 */
abstract read(id: ActivityId, from: number, caller?: Agent): ActivityRead

/**
 * Register an effect-scoped observer of visible-set changes: opening,
 * detail updates, settlement, owner-disposal removal, and the emptying that
 * service disposal commits — so an observer re-reads rather than
 * accumulating deltas. Listeners are contained and never awaited.
 * @param listener - receives the owner whose visible set changed, or
 *   `undefined` when an unowned activity changed and every caller's set did.
 * @returns disposer that unregisters the listener.
 */
abstract onActivitiesChanged(listener: ActivitiesChangedListener): () => void

/**
 * Register an effect-scoped observer of stream advancement — one signal per
 * committed append and one at settlement, carrying only the activity id.
 * A consumer schedules a {@link read} from its own cursor; the registry
 * never pushes payloads. Listeners are contained and never awaited.
 * @param listener - receives the id whose stream advanced.
 * @returns disposer that unregisters the listener.
 */
abstract onOutput(listener: ActivityOutputListener): () => void
```

Types: [Agent](core.zh.md)

Source: [`packages/activity/activity/src/index.ts`](../../packages/activity/activity/src/index.ts)

<a id="ctxactivitycontroller--activitycontroller"></a>

### `ctx.activityController` — `ActivityController`

Host service backing the generated `ctx.remote.activity` namespace.

```ts cordis-catalog
/**
 * Stream a complete roster baseline followed by whole-bucket replacements.
 * @param signal - generation cancellation.
 * @returns baseline followed by per-owner roster replacement frames.
 */
@Remote({ mode: 'stream' }) control(signal: AbortSignal): AsyncIterable<ActivityControlFrame>

/**
 * Stream one activity's retained output from an absolute byte offset, then
 * its terminal status once settled and drained. Non-consuming: the
 * model-facing cursors never observe these reads.
 * @param request - target activity and optional resume offset.
 * @param signal - generation cancellation.
 * @returns anchor, coalesced output frames, and the terminal status.
 */
@Remote({ mode: 'stream' }) observe(request: ActivityObserveRequest, signal: AbortSignal): AsyncIterable<ActivityObserveFrame>
```

Source: [`packages/api/activity-controller/src/index.ts`](../../packages/api/activity-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
