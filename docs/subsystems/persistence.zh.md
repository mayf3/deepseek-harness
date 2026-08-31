# 会话持久化

[English](persistence.md) | 中文

事件日志的**持久性 seam**。[session.md](session.zh.md) 描述了内存中的 `Session`：仅追加的 `SessionEvent` 日志即为真源。本页描述如何使该日志持久化：抽象的 `SessionPersistence` 服务、它的提供方模型与随产品交付的 JSONL 后端、flush 检查点、崩溃恢复，以及随日志一同存储的元数据头。日志承载的事件词汇在生成的[持久化日志事件目录](../persistence-catalog.zh.md)中逐项列举。

该 seam 是一个[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)：一个抽象服务（[dsh-session-persistence](../../packages/session/session-persistence)，`ctx.sessionPersistence`）在现有 `SessionEvent` 上定义 locate/create/append、可复用的 Session 准备流程、逻辑 load/inspect、物理后缀读取，以及轻量的 list/snapshot 观察——**没有平行的持久化事件类型**。仓库随产品交付 [dsh-session-persistence-jsonl](../../packages/session/session-persistence-jsonl) 作为提供方；仓库外提供方可以实现同一服务约定。见 [session-persistence Agent Note](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.zh.md)。

## flush 检查点

`session/event` 是一个*同步*通知；持久化插件会将事件复制到逐会话控制器，而不阻塞生产方。第一个待处理事件会开启固定批处理窗口，后续事件会加入但不会重置截止时间。窗口到期后会启动一个持久化批次；该次写入期间接纳的事件会获得自己的截止时间，并形成后续批次。`session/flush` 会取消等待并排空至完全停稳，因此循环仍将其用作在领取下一个普通轮次之前的顺序与错误观察检查点。后台写入被拒绝时会保留对应事件并暂停自动重试；新事件会开启新的固定窗口，而显式 flush 会立即重试，并通过 `agent/error` 和 logger 报告失败，绝不会把失败记录成已关闭轮次之后的会话事件。dispose（资源释放）会执行同样的最终排空。配置的最大值只限制有意的批处理等待，不限制事件循环调度或后端完成持久化的延迟（[决策](../../.agents/notes/implemented/architecture/2026-08-08-bounded-session-persistence-write-batching.zh.md)）。

## 崩溃恢复保留被中断的轮次

后端重新加载一个在轮次中途崩溃的日志时，会发现一个已打开的 `turn/start` 却没有 `turn/end`。它**不会**截断日志：在长周期任务中，单个轮次可能非常庞大（许多步骤、大量工具输出），而这些事件在崩溃前已被持久追加。后端改为用一个合成的 `turn/end { reason: { kind: 'interrupted' } }` 关闭这个遗留轮次，在不改变其前后任何独立事件的情况下配平被中断的执行。`interrupted` 是唯一一个不由循环发出的 `TurnEndReason`（见 [session.md](session.zh.md#why-a-turn-ended-turnendreasonmap)）。

修复仅适用于冷会话。对于活跃 id，`SessionPersistence.load(id)` 会等待权威内存快照完成持久化，并且只在日志平衡时返回；若活跃轮次仍未闭合，则拒绝操作，而不是添加合成的中断边界。HMR（热模块替换）会接管活跃前缀，而不会关闭其中正在进行的轮次。

`SessionPersistence.inspect(id)` 会构造一个不可变的逻辑 Session，但不发布它。对于已经是当前格式的冷 generation，检查只在内存中配平中断轮次，不写入恢复内容，并保持撕裂的物理尾部不变。受支持的历史 generation 不同：串行化正文读取操作会先在保留源文件的同时，于新的版本限定路径发布已修复当前后继，因此检查永远不会暴露旧逻辑格式。检查已处于活跃状态的 Session 会借用其当前不可变快照，因此可能包含未闭合的轮次。使用协调器的实现会在有界 LRU 中保留这个精确的冷未发布 Session，因此重复历史读取与后续 `prepare(id)` 可复用同一次读取、解压、验证、冻结及 Session 构造。`prepare(id)` 会预留该 Session、提交待处理的当前格式修复并返回可 dispose 的发布句柄；`load(id)` 使用相同机制提交修复，但不会发布 Session。该生命周期由 [Session 准备阶段决策](../../.agents/notes/implemented/architecture/2026-08-05-session-preparation.zh.md)定义。

## `SessionLocation`——可选的逐会话产物目标

`SessionPersistence.locate(meta)` 会同步解析归后端所有的独立产物目标，而不会读取、创建或 flush 它。JSONL 根据 `meta.version` 派生规范文件名：v0 是 `session.jsonl[.zstd]`，每个正版本都是小写 `session.vN.jsonl[.zstd]`。不为每个 Session 各自拥有独立产物的后端返回 `undefined`。返回路径可能尚不存在，也不说明目录中是否已经存有另一个更高 generation；它是版本限定的位置提示，不是授权、发现或新鲜度保证。仅 header 的列表负责发现，并在 `listing.location` 中返回精确选定 generation。

```ts type-equiv
/**
 * A backend-resolved, per-session local artifact location. The path is an
 * absolute target path and can name an artifact that has not materialized yet.
 * Consumers must treat it as a location hint, never as an authorization token.
 */
interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}
```

<a id="sessionheader--metadata-beside-the-log"></a>

## `SessionHeader`：日志旁的元数据

每个会话的元数据与事件日志**分开**存储：header 携带格式版本、cwd 与 `isSeeded` 谱系 bit，含正文的存储值则在其旁边单独携带精确 inherited cut。二者都不进入 `SessionEventMap`，也不会到达 `deriveMessages()`。logical header 通过 `session.header` 附加，Session 则以 `inheritedEventCount` 暴露其 cut。

源码：[`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
interface SessionHeader {
  /**
   * Current logical format version, stamped from {@link SESSION_FORMAT_VERSION}.
   * Historical physical headers are translated before entering this interface.
   */
  readonly version: typeof SESSION_FORMAT_VERSION
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId
  /**
   * Whether this Session contains a fork-inherited event prefix. The exact prefix
   * length is Session state rather than ordinary header metadata.
   */
  readonly isSeeded: boolean
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  readonly origin?: 'subagent'
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number
  /**
   * Id of the agent preset this session's agent was composed from, when the
   * deployment composes per session. Durable because the preset decides the
   * session's tools and prompt: a resume that restored a different composition
   * would replay history the model can no longer act on.
   */
  readonly agentPreset?: string
}
```

## 格式拒绝：本构建无法可靠读取的日志

后端用 `SessionFormatUnsupportedError` 拒绝无法可靠解读的日志，它与 `SessionPersistenceCorruptionError` 区分，因为数据没有损坏。仅 header 的列表会重新扫描，并在应用事件规则前分类数值最高的规范 generation。受支持的旧版本会报告为 migration-required；每个事件正文读取都在逐 Session 串行链中运行，完成静态相邻迁移操作，保持源路径、字节与 inode 不变，以排他方式只发布最终当前文件名，并在当前恢复前重新打开。即使仍有可读旧 generation，最高 generation 是未来版本时也会拒绝。catalog 生成与初始化会拒绝缺失的迁移边。alpha 正文迁移拒绝仍是 unsupported，且不发布任何文件。同版本读取只有在信封带 `ignorable: true` 时才允许未知事件；历史 v0 迁移有意拒绝每个未知类型，包括 ignorable 类型。保留不提供自动 fallback，也不承诺 downgrade compatibility。见[已发布格式生命周期](../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)与 [alpha 历史事件规则](../../.agents/notes/implemented/architecture/2026-08-31-alpha-historical-unknown-event-refusal.zh.md)。

## `CreateSessionOptions`：seed 与元数据

通过 store 创建 `Session` 时会接收 `seed`（初始回放或 fork 历史）、可选的精确 `inheritedEventCount` 与 `meta`（store 整合进 `SessionHeader` 的存储层字段）。store 填充 `version`/`id` 并为 `createdAt` 提供默认值；调用方可以提供已校验的绝对 `cwd`、`parentSession` 谱系、`isSeeded` 谱系标记、可选的粗粒度 `origin`、`delegationDepth`、用于组装该 agent（智能体）的 `agentPreset` 以及已有的 `createdAt`。seeded 创建必须同时显式提供 seed 与精确 cut，因为继承前缀之后还可能存在 child-owned setup event。`origin: 'subagent'` 让产品导航能够隐藏重复的 child 行；它不证明描述符有效，也不证明 child 可以恢复。

```ts type-equiv
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[]
  /**
   * Exact fork-inherited prefix length when `meta.isSeeded` is true. A
   * In v2 the constructor seed is exactly this inherited prefix; the constructor
   * appends the child-owned tagged marker at the cut.
   */
  readonly inheritedEventCount?: SessionLogOffset
  /**
   * Storage metadata read once before publication. `isSeeded` marks fork
   * lineage; supplying replay history alone does not make it inherited.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
}
```

因此，普通回放的调用方式为 `ctx.sessions.create(id, { seed: seedEvents })`；fork 还会提供 `inheritedEventCount` 与 `meta.isSeeded: true`。将一个*持久化*会话恢复为活跃 agent 的调用方式为 `ctx.agents.resume({ resumeSessionId })`。

## `SessionStorageMetadata`：逻辑 header 与继承 cut

每个读取 Session 正文的持久化结果都携带 `SessionStorageMetadata`：当前逻辑 header，以及单独校验的继承事件 cut。仅 header 的列表不携带继承 cut；其中 current 与 migration-required descriptor 暴露最新 `SessionHeader`，unsupported 与 malformed descriptor 则不暴露。

```ts type-equiv
/** Logical Session header paired with its exact inherited cut for body-bearing storage operations. */
interface SessionStorageMetadata {
  /** Validated immutable Session header. */
  readonly meta: SessionHeader
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset
}
```

## `SessionRawArtifact`——逐字存储工件文本

后端为一个 Session 选定的 generation 文本，在解码物理压缩后与其持久写入内容逐字节相同。`readRaw` 不通过已解析事件重建就返回该文本，因此 key 顺序、换行与历史 v0/v1 packed row 都会保留。当前 JSONL v2 为每个持久事件存储一行。JSONL 把 `filename` 设为不带 `.zstd` 的选定逻辑 basename：v0 为 `session.jsonl`，每个正 generation 为 `session.vN.jsonl`。消费方先检查 `supportsRawArtifacts`：`false` 表示后端不提供该能力，而 `readRaw(...) === undefined` 表示支持该能力的后端中不存在该 Session 的已物化 generation。

```ts type-equiv
/** A backend's own raw artifact text for one session, verbatim. */
interface SessionRawArtifact extends SessionStorageMetadata {
  /** Selected generation basename; physical `.zstd` is omitted, while `.vN` remains. */
  readonly filename: string
  /** The artifact's full text content, decoded from the backend's physical encoding. */
  readonly content: string
}
```

## 准备与恢复所有权

`SessionStore.prepare()` 接收普通创建选项，或通过 `RestoredSessionOptions` 转移所有权的全新的持久化对象图。恢复分支会就地验证并冻结转移来的 header 与事件，因此调用方不得保留可变别名。`SessionPreparation` 随后持有该精确的未发布 Session，直至发布或回滚；dispose 是同步且幂等的。持久化检查只暴露 `SessionInspection`，即从同一个已准备 Session 借用的不可变逻辑视图。

```ts type-equiv
/**
 * Fresh storage values transferred to {@link SessionStore.prepare} without a
 * second serialization copy. Callers retain no mutable aliases.
 */
interface RestoredSessionOptions {
  /** Fresh detached storage events to validate and freeze in place. */
  readonly seed: SessionEvent[]
  /** Fresh detached storage metadata to validate and freeze in place. */
  readonly meta: SessionHeader
  /** Exact number of fork-inherited leading events decoded from storage. */
  readonly inheritedEventCount: SessionLogOffset
  /** Select the persistence ownership-transfer path. */
  readonly seedSource: 'persistence'
}
```

```ts type-equiv
/** Inputs accepted while constructing an unpublished Session. */
type PrepareSessionOptions =
  | (CreateSessionOptions & { readonly seedSource?: undefined })
  | RestoredSessionOptions
```

```ts type-equiv
/** Options for a preparation whose provider retains unpublished state. */
interface SessionPreparationOptions {
  /** Release provider-owned state when the Session was not published. */
  readonly release?: () => void
}
```

```ts public-api
/**
 * One exact unpublished Session and the provider state that keeps it usable.
 * Disposal is synchronous and idempotent. Providers decide whether release
 * returns the Session to a cache or discards it; publication may consume that
 * state before disposal, making the callback a no-op.
 */
declare class SessionPreparation implements Disposable {
  /** The exact Session to use for setup and publication. */
  readonly session: Session;
  /**
   * Wrap an unpublished Session in one preparation lifetime.
   * @param session - exact unpublished Session.
   * @param options - optional provider release behavior.
   * @returns a preparation disposed after publication or rollback.
   */
  static create(session: Session, options?: SessionPreparationOptions): SessionPreparation;
  /** Release provider state once when this preparation leaves its caller. */
  [Symbol.dispose](): void;
}
```

```ts type-equiv
/** Immutable logical session prepared from persistence or a live owner. */
interface SessionInspection extends SessionStorageMetadata {
  /** Validated contiguous logical event log. */
  readonly events: readonly SessionEvent[]
}
```

## 分离的持久日志后缀

`readFrom` 返回以请求的 `fromSeq` 为锚点、与其他状态分离的 `SessionEventSuffix`。其事件列表可能从非零位置开始，也可能为空，因此它不是完整的 `SessionInspection`，不得作为完整 Session 恢复。

```ts type-equiv
/** Detached logical suffix returned by one explicit stored-log offset read. */
interface SessionEventSuffix extends SessionStorageMetadata {
  /** First requested log offset; {@link events} contains only seqs at or after it. */
  readonly fromSeq: SessionLogOffset
  /** Valid contiguous stored events at or after {@link fromSeq}; not a complete Session log when the offset is nonzero. */
  readonly events: readonly SessionEvent[]
}
```

## 轻量源修订号

派生状态的消费方会在加载完整事件日志之前比较一个低开销的不透明修订号。其表示由持久化后端拥有，并随 append、会修改数据的 load 修复或后继发布以事务方式改变；调用方仅比较修订号是否相等。仅 header 的列表会重新扫描每个 Session 目录，并为其最高规范 generation 返回一个带标签 descriptor：`current` 与 `migration-required` 结果暴露最新逻辑 header，`unsupported` 与 `malformed` 结果则只暴露该选定文件的位置和诊断。

| 状态 | Header | 版本与诊断事实 |
|---|---|---|
| `current` | 最新逻辑 header | 最高存储版本、目标版本、精确选定位置 |
| `migration-required` | 在内存中转换后的最新 header | 最高存储版本、目标版本、精确历史源位置 |
| `unsupported` | 无 | 可选存储版本、目标版本、必需的位置与原因 |
| `malformed` | 无 | 目标版本、必需的位置与原因 |

```ts type-equiv
/**
 * Backend-owned token that identifies both one storage source and one revision
 * of a persisted session log.
 */
type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>
```

```ts type-equiv
/** One complete header-only listing result; event bodies are never read. */
type SessionPersistenceListing =
  | CurrentSessionPersistenceListing
  | MigrationRequiredSessionPersistenceListing
  | UnsupportedSessionPersistenceListing
  | MalformedSessionPersistenceListing
```

```ts type-equiv
/** Lightweight immutable source identity returned without loading a full log. */
type SessionPersistenceSnapshot = SessionPersistenceListing & {
  /** Opaque source-qualified token that changes whenever this stored artifact changes. */
  readonly revision: SessionPersistenceRevision
}
```

## 后端

随产品交付的 provider 实现抽象 `SessionPersistence` 约定（在 `SessionEvent` 上执行 locate/create/append/prepare/load/inspect/readFrom/list/listSnapshots，观察方法可选支持取消），并通过共享的 `runPersistenceContract` 套件：

- **[dsh-session-persistence-jsonl](../../packages/session/session-persistence-jsonl)**——逐 Session 使用规范不可变 generation 文件名，默认存储为带 checksum 的连续 Zstandard frame，也可配置为原始行；普通写入仅追加，在保留前任的同时排他发布后继，并支持中断轮次恢复与读取／回放。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionpersistence--sessionpersistence-abstract-seam"></a>

### `ctx.sessionPersistence` — `SessionPersistence` (abstract seam)

Durable append-only session storage. Implementations preserve contiguous, losslessly JSON-serializable events; append resolves only after durability, and load balances a complete interrupted tail without rewriting committed events.

```ts cordis-catalog
/**
 * Resolve this backend's current-generation target for a session without
 * reading, creating, flushing, or otherwise materializing it. Historical
 * generations may live at other immutable paths; listing descriptors carry
 * the exact selected stored location. A backend without per-Session files
 * returns `undefined`.
 * @param meta - the immutable session header whose artifact is requested.
 * @returns the backend-specific absolute location, when one exists.
 */
abstract locate(meta: SessionHeader): SessionLocation | undefined

/**
 * Read a session's backend-owned artifact text verbatim — the exact durable
 * bytes the backend wrote (decoded from its physical encoding, e.g. a
 * decompressed JSONL). The returned `content` is the raw text, not a
 * reconstruction from parsed events, so it preserves backend-specific
 * serialization (chunk packing, key order, line breaks). Callers first test
 * {@link supportsRawArtifacts}; `undefined` then means only that the requested
 * session has no materialized artifact. Reading a supported historical
 * artifact leaves that generation untouched and exclusively publishes a
 * separate repaired current successor; an already-current artifact is not rewritten.
 * @param _id - the persisted session to read (unused by the default: no
 * per-session artifact).
 * @param signal - optional cancellation for backend read work.
 * @returns the raw artifact plus its parsed header, or `undefined` when the
 * session is absent.
 * @throws when this backend does not expose per-session raw artifacts.
 */
readRaw(_id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined>

/**
 * Register a new session's metadata. A backend MAY defer the physical write
 * until the first {@link append} (lazy materialization), in which case a
 * created-but-never-appended session is absent from {@link list}
 * — abandoned sessions leave nothing behind.
 * @param meta - the immutable header (id, version, cwd, lineage) to record.
 * @param inheritedEventCount - exact fork-inherited prefix length. Required
 * for a seeded header and omitted only for an unseeded header.
 */
abstract create(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): Promise<void>

/**
 * Ensure a live session has a durable header even when it has no events.
 * Ordinary sessions remain lazily materialized; lifecycle frontends call
 * this only when an empty session itself is a durable resumable resource.
 * @param _session - exact live session whose registered header is materialized.
 */
ensureMaterialized(_session: Session): Promise<void>

/**
 * Durably persist a batch of events. Honors the append-only and contiguous-
 * seq contracts: the first event's `seq` MUST equal the stored next-seq
 * (after `load` has durably closed any interrupted turn). Rejects non-JSON-
 * serializable `event.data` with an error naming the offending event type.
 * A seeded session's first materializing batch must reach its complete
 * inherited prefix.
 * @param id - the session the batch belongs to.
 * @param events - the contiguous batch to persist, in seq order.
 */
abstract append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

/**
 * Prepare the exact unpublished Session used by resume. Implementations may
 * reuse object graphs retained by an earlier {@link inspect} after confirming
 * their durable revision is still current; disposal releases an unpublished
 * reservation. Revision retries require the durable log to remain unchanged
 * for one read/check round trip; continuous external writers may delay completion.
 * Preparing a supported historical artifact first persists its migration and
 * current-format repair, while current input takes the no-write fast path.
 * @param id - persisted session to prepare.
 * @param signal - optional cancellation for this caller's wait. A shared
 * preparation or historical migration already started for another observer
 * may continue to completion.
 * @returns one owned unpublished Session preparation.
 */
async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>

/**
 * Load an immutable balanced current logical view and commit any required cold
 * recovery. A supported historical artifact remains immutable while a
 * separate repaired current successor is published before restoration. A complete
 * interrupted final turn is preserved and durably
 * closed with missing tool errors plus any open step and turn boundaries;
 * only a torn final record is discarded. Unknown versions and corruption in
 * the committed prefix reject. Implementations MUST NOT crash-repair an
 * identity still bound to a live Session: a balanced live log may return as a
 * durable snapshot, while an open live turn rejects. Returned values may be
 * shared with immutable live or prepared state and must not be mutated.
 * Revision-based implementations may wait for one stable read/check round trip.
 * @param id - the persisted session to reload.
 * @returns the header and a log ending on a balanced `turn/end`.
 */
abstract load(id: SessionId): Promise<SessionInspection>

/**
 * Inspect an immutable current logical session without publishing a live
 * Session. For an already-current cold artifact, a complete interrupted turn receives
 * synthetic closers only in memory and a torn physical tail remains untouched.
 * A supported historical artifact first publishes its separate repaired
 * current successor, so inspection is not storage-read-only in that case. An
 * already-live Session instead yields its current immutable snapshot, which may contain an
 * open turn and its `session/end-seed` boundary. Coordinator-backed
 * implementations retain the exact cold unpublished Session for bounded
 * reuse by a later {@link prepare}. A stale ready source is reloaded; a source
 * already committing or reserved for resume remains exclusive, and inspection
 * may borrow its immutable view. Callers borrow only the immutable header and
 * log. Continuous external writers may delay revision convergence.
 * @param id - the persisted session to inspect.
 * @param signal - optional cancellation for this observer. Shared cold
 * preparation and an already-started historical migration may continue for
 * another inspector or later resume.
 * @returns the validated header and current logical event log.
 */
abstract inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>

/**
 * Borrow one exact inspection while retaining any reusable prepared source.
 * A cold observation must pin the exact prepared Session that a later
 * {@link prepare} reserves. Implementations must not degrade this operation
 * to a detached {@link inspect} result. Borrowing a supported historical
 * artifact first persists its migration and current-format repair.
 * @param id - persisted session to observe.
 * @param signal - optional cancellation for this observer's wait; shared
 * preparation or migration work may continue for another owner.
 * @returns a disposable immutable observation.
 */
abstract borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource>

/**
 * Read the stored events from `fromSeq` onward — the read-from-seq
 * primitive for read models that resume from a watermark (e.g. a persisted
 * projection cache folding only the tail past its checkpoint). Unlike
 * {@link inspect}, it is a detached physical suffix read: no preparation
 * cache or coordinator-state publication. Current input performs no
 * torn-tail truncation or synthetic repair. A supported historical artifact
 * leaves its exact source unchanged and publishes a separate repaired current
 * successor, so its returned suffix may include those current closers.
 * Only events from the valid contiguous stored prefix are
 * returned, so a torn fragment never reaches the caller. `fromSeq` at or
 * beyond the stored prefix returns an empty event list (never an error).
 * A backend whose medium can seek by seq may read only the suffix;
 * sequential media such as JSONL still parse the whole artifact and skip
 * forward. The primitive bounds what is returned and refolded, not every
 * backend's physical read.
 * @param id - the persisted session to read.
 * @param fromSeq - first event offset to include.
 * @param signal - optional cancellation for queued and backend read work.
 * @returns storage metadata, the requested offset, and stored events with `seq >= fromSeq`.
 */
abstract readFrom(id: SessionId, fromSeq: SessionLogOffset, signal?: AbortSignal): Promise<SessionEventSuffix>

/**
 * Lightweight listing from metadata, without a full-log parse.
 * @param signal - optional cancellation for backend listing work.
 * @returns one isolated descriptor per materialized artifact.
 */
abstract list(signal?: AbortSignal): Promise<SessionPersistenceListing[]>

/**
 * List materialized sessions with cheap per-log change tokens.
 *
 * Repeated observations of an unchanged log return the same revision. A
 * successful mutating {@link load} repair changes the next listed revision;
 * so does migration publication from any supported historical body read.
 * Revisions also distinguish independently backed stores so backend-local
 * counters cannot compare equal across different persistence sources.
 * @param signal - optional cancellation for backend snapshot-listing work.
 * @returns one isolated current, migration-required, unsupported, or malformed
 * descriptor plus its opaque revision per materialized artifact, without
 * loading full logs.
 */
abstract listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>
```

Types: [Session](session.zh.md) · [SessionEvent](session.zh.md) · [SessionId](core.zh.md) · [SessionLogOffset](session.zh.md)

Source: [`packages/session/session-persistence/src/index.ts`](../../packages/session/session-persistence/src/index.ts)
<!-- END GENERATED cordis-surface -->
