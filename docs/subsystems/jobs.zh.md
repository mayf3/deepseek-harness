# 后台任务运行时

[English](jobs.md) | 中文

长时间运行的生产方、`ctx.jobs` 与任务控制命令共用的类型。[运行时 Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md) 负责设计；本页记录 [`packages/jobs/jobs/src/types.ts`](../../packages/jobs/jobs/src/types.ts) 中的确切字段和变体。

## ID 与状态

`JobId` 是按 `<kind>-N` 生成的[品牌化 id](core.zh.md#branded-ids)。访问控制依赖拥有者授权，而非 id 的保密性。`JobKind` 派生自可合并扩展的 map；注册表将各个 kind 视为不透明的 id 命名空间。

```ts type-equiv
/**
 * Producer-defined job kinds. Plugins extend this map by declaration merging;
 * the registry treats every value as an opaque id namespace.
 */
interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}
```

`JobStatus` 为 `'running' | 'stopping' | 'completed' | 'killed' | 'failed'`；生产方特有的事实归入 `JobSnapshot.detail`。

## 生产方约定

`JobStart` 声明身份和启动器，并按 `record` 判别：`RecordingJobStart` 收到 `RecordingJob` 面，`PlainJobStart` 收到没有 `append` 的 `RunningJob` 面。运行时会在完成预检后携带该面调用 `run()`，随后提交注册，不再执行可能失败的步骤。生产方拥有执行资源；运行时拥有身份、访问权限和生命周期状态。

```ts type-equiv
/**
 * A start with the model-facing surfaces only. Its producer face carries no
 * `append`, so output the registry would have nowhere to keep is
 * unrepresentable rather than dropped.
 */
interface PlainJobStart extends JobStartBase {
  record?: undefined
  /**
   * Start the work after preflight and synchronously return its hooks. Called
   * once with the job's producer face; a throw leaves nothing registered (the
   * spent ordinal is skipped), and the producer must clean up any partially
   * started resources.
   * @param job - the issued id plus the live-detail writer.
   */
  run(job: RunningJob): JobHooks
}
```

```ts type-equiv
/**
 * A start that declares an observable output record beside the model-facing
 * surfaces: {@link RecordingJob.append} retains chunks in a bounded ring that
 * any number of observers read at absolute byte offsets through
 * {@link JobRegistry.readRecord}, and snapshots carry
 * {@link JobSnapshot.outputTotal} and {@link JobSnapshot.outputEarliest}.
 */
interface RecordingJobStart extends JobStartBase {
  record: true
  /**
   * Start the work after preflight and synchronously return its hooks. Called
   * once with the job's producer face; a throw leaves nothing registered (the
   * spent ordinal is skipped), and the producer must clean up any partially
   * started resources.
   * @param job - the issued id plus the record append and live-detail writers.
   */
  run(job: RecordingJob): JobHooks
}
```

```ts type-equiv
/**
 * Producer declaration passed to {@link JobRegistry.start}, discriminated by
 * `record`. The runtime preflights access and cleanup before invoking `run`;
 * the producer owns execution resources while the runtime owns identity and
 * lifecycle state.
 */
type JobStart = PlainJobStart | RecordingJobStart
```

`JobHooks.done` 会在生产方释放其资源后 resolve，而不是仅在工作完成时 resolve。可选的 `readOutput` 用来区分会消费输出的流式任务和仅有最终输出的任务。

```ts type-equiv
/** Hooks through which the runtime controls and observes producer work. */
interface JobHooks {
  /**
   * Request termination. Must be synchronous, idempotent, and eventually settle
   * {@link done}; throws propagate. The optional reason is forwarded verbatim.
   */
  cancel(reason?: string): void
  /**
   * Resolves after the producer releases its resources, not merely when work
   * finishes. Must not reject; the runtime converts a rejection to `failed`.
   * If teardown cancellation throws, the runtime may force-fail only the
   * registry record without claiming that the work stopped. Settlement also
   * ends the record: fold any record-filling pump into this promise so the
   * final drain lands before the registry trims and closes the stream.
   */
  done: Promise<JobOutcome>
  /**
   * Consume output produced since the previous call. The producer formats
   * truncation and spill notices. Absence marks a final-output-only job; each
   * job has one consuming cursor. Independent of the record: this is the
   * model-facing projection, {@link JobRegistry.readRecord} the observer one.
   */
  readOutput?(): string
}
```

```ts type-equiv
/** Terminal result supplied by a producer through {@link JobHooks.done}. */
interface JobOutcome {
  /** How the job ended: finished (`completed`), cancelled (`killed`), or broke (`failed`). */
  status: 'completed' | 'killed' | 'failed'
  /** Kind-specific detail rendered into status lines ('exit code: 3', 'max-tokens'). */
  detail?: string
  /** Final output for jobs without `readOutput`; stream jobs leave it unset. */
  output?: string
}
```

## 观测 record

声明 `record: true` 的生产方通过 starter 收到的 `RecordingJob` 面把原始输出流入按 job 划分的有界环形缓冲；任意数量的观察者通过 `readRecord` 按绝对字节偏移读取保留块，不触碰消耗型的模型游标与通知状态。job 结算即封流并把保留量裁剪到结算上限——record 没有独立生命周期。`pumpJobOutput` 以有界节奏把生产方的偏移读取器（subprocess 的 `readFrom` 家族）复制进 record。浏览器经 [`dsh-api-job-controller`](../../packages/api/job-controller/README.zh.md) 的 Remote 流 `job.observe` 读取 record，其帧类型列在下方该控制器的 Cordis API 一节。

```ts type-equiv
/**
 * Producer face of one registered job, handed to `run` and valid for the
 * job's whole life. All methods are synchronous. Writes staged inside the
 * starter call are retained and become visible with the registration commit;
 * after settlement — the producer's own outcome, a kill, or a registry-forced
 * teardown end — writes log and drop instead of throwing, so a producer's
 * trailing flush cannot break its own teardown path.
 */
interface RunningJob {
  /** The registry-issued id (`<kind>-N`). */
  readonly id: JobId
  /**
   * Replace the snapshot's status detail with a live progress line (`3/10`).
   * @param detail - the new detail line.
   */
  updateDetail(detail: string): void
}
```

```ts type-equiv
/** Producer face of a {@link RecordingJobStart}: {@link RunningJob} plus the record append. */
interface RecordingJob extends RunningJob {
  /**
   * Append one record chunk. Offsets advance by the chunk's UTF-8 byte
   * length; an empty chunk is dropped without waking observers.
   * @param text - the chunk text, exactly as produced.
   * @param options - stream label and gap marker.
   */
  append(text: string, options?: JobAppendOptions): void
}
```

```ts type-equiv
/** One retained record chunk returned by {@link JobRegistry.readRecord}. */
interface JobRecordChunk {
  /** Absolute offset of the chunk's first byte. */
  at: number
  /** Chunk text exactly as appended (possibly tail-trimmed by retention). */
  text: string
  /** Stream label, when the producer supplied one. */
  channel?: JobChannel
  /** Producer-reported loss immediately before this chunk. */
  gapBefore?: true
}
```

```ts type-equiv
/** Result of one non-consuming {@link JobRegistry.readRecord}. */
interface JobRecordRead {
  /** Retained chunks overlapping `[from, total)`, in offset order. */
  chunks: readonly JobRecordChunk[]
  /**
   * Offset to resume from — the record's current `outputTotal`. Always a
   * chunk boundary: appends land whole and trimming only advances chunk
   * starts, and consumers concatenate `chunks` under that assumption, so a
   * provider serving partial chunks would silently duplicate text.
   */
  next: number
  /** True when `from` fell below the oldest retained byte, so bytes are missing before `chunks`. */
  lossy: boolean
}
```

## 消费方视图

快照是每次新建的只读投影。`ownerSession` 携带用于授权的共享 `SessionId`；完成监听器则会另行收到用于生命周期清理的确切拥有者对象。另一个接口已经交付终止状态或承诺交付时，`reported` 会抑制完成通知；排空 owner 或服务的 teardown 取消同样计入。

```ts type-equiv
/**
 * A read-only projection of one job, safe to hand to listeners and tools —
 * a fresh object per call, never live registry state.
 */
interface JobSnapshot {
  /** The registry-issued id (`<kind>-N`). */
  id: JobId
  /** The producer kind the job was registered with. */
  kind: JobKind
  /** The producer-supplied one-line label. */
  label: string
  /** Producer-owned cap for complete model-facing notices and output reads. */
  outputLimitBytes?: number
  /**
   * Owner session id used for authorization and correlation; absent for
   * unowned jobs. Completion listeners receive the exact {@link Agent}
   * separately through {@link JobDoneListener}.
   */
  ownerSession?: SessionId
  /** Current lifecycle state. */
  status: JobStatus
  /**
   * Kind-specific status detail: live progress while the producer updates it
   * through {@link RunningJob.updateDetail}, the terminal detail once settled.
   */
  detail?: string
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** Epoch ms when the job settled; absent while `running`/`stopping`. */
  finishedAt?: number
  /**
   * True when a kill, read, wait, or teardown cancel has reported or committed
   * to report the terminal state. Completion reporters suppress redundant
   * notices when set. Teardown claims it because the owner or service being
   * destroyed leaves no reader: a reporter that opens a turn on notice would
   * otherwise spend a model request per teardown layer.
   */
  reported: boolean
  /**
   * Total UTF-8 bytes ever appended to the record — the offset the next chunk
   * starts at. Present exactly when the job declared {@link JobStart.record}.
   */
  outputTotal?: number
  /**
   * Offset of the oldest retained record byte. Greater than zero exactly when
   * retention dropped the head; a reader starting below it gets a lossy read.
   * Present exactly when the job declared {@link JobStart.record}.
   */
  outputEarliest?: number
}
```

```ts type-equiv
/** Output and post-read state returned by {@link JobRegistry.read}. */
interface JobRead {
  /**
   * Stream kinds: the consuming delta since the previous read. Final-output
   * kinds: empty while live, the terminal {@link JobOutcome.output} (or
   * empty) once settled — idempotent, never consumed.
   */
  text: string
  /** The job's state at read time. */
  snapshot: JobSnapshot
}
```

## 服务行为

抽象的 [`JobRegistry`](../../packages/jobs/jobs/src/index.ts) Service Definition 规定了原子化的 `start`、按调用方划定的 `get` 与 `list`、`read`、非消耗的 `readRecord`、`kill`、有界的 `wait`、故障隔离的 `onJobDone`、`onJobsChanged` 与 `onOutput` 监听器，以及 `attachController`；[`LocalJobRegistry`](../../packages/jobs/jobs-local/src/index.ts) 是进程本地的 Service Provider。授权比较 owner 会话；owner 清理与准入使用注册在案的确切 `Agent` 实例。本地 provider 的正安全整数配置 `maxConcurrentJobsPerOwner` 默认 `10`，按确切 owner 统计 `running` 加 `stopping` 记录，无主任务共享一个桶；生产方终态结算释放容量，`retainBytes`（默认 262144）与 `settledRetainBytes`（默认 16384）约束每个已声明 record 的运行期与结算后保留量。参见 [`dsh-jobs`](../../packages/jobs/jobs/README.zh.md)（Service Definition 契约）、[`dsh-jobs-local`](../../packages/jobs/jobs-local/README.zh.md)（注册表生命周期与准入策略）与 [`dsh-tool-jobs`](../../packages/jobs/tool-jobs/README.zh.md)（模型侧 Consumer）。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjobcontroller--jobcontroller"></a>

### `ctx.jobController` — `JobController`

Host service backing the generated `ctx.remote.job` namespace.

```ts cordis-catalog
/**
 * Stream one job's retained record output from an absolute byte offset,
 * then its terminal status once settled and drained. Non-consuming: the
 * model-facing cursor and notice state never observe these reads. The
 * request's session resolves the fenced-read caller; the registry rejects a
 * job the session does not own, a job without a record, or an unknown job.
 * @param request - target job, owning session, and optional resume offset.
 * @param signal - cancellation owned by the Remote stream carrier.
 * @returns anchor, coalesced output frames, and the terminal status.
 */
@Remote({ mode: 'stream' }) observe(request: JobObserveRequest, signal: AbortSignal): AsyncIterable<JobObserveFrame>
```

Source: [`packages/api/job-controller/src/index.ts`](../../packages/api/job-controller/src/index.ts)

<a id="ctxjobs--jobregistry-abstract-seam"></a>

### `ctx.jobs` — `JobRegistry` (abstract seam)

Abstract background job registry. Subclass, implement the abstract methods, and load the subclass as a plugin — it registers as `ctx.jobs` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Registrations outlive producer and controller fibers. Owner and service disposal cancel live work and await compliant producers; a throwing teardown cancel force-fails only the record. Teardown cancellation also marks the record reported, because a record its owner is being destroyed for has no reader left.
- Owned-job access is fenced by the owner's session id. Ids are predictable, so authorization — not secrecy — is the boundary.
- Settlement is first-wins: one terminal record, released waiters, and one round of contained listener notification, even against a late producer outcome. Completion is announced last, after the record is committed and every other observer of the settlement has seen it, because a reporter may open a model turn synchronously.
- start refuses work while no attached job controller serves the spec's owner, so a producer cannot start work that owner cannot collect or stop. One registry serves every composition in the process, so this question — and completion-listener delivery — is owner-relative rather than process-wide: registrations made from an unscoped context serve every owner, and registrations made under an agent composition's scope serve exactly the agents composed under it.
- Record observation never consumes. Any number of readRecord readers hold their own absolute byte offsets; a record read changes no cursor and no notice state, so the model-facing surfaces (the consuming read, completion notices) are unaffected.
- Record retention is bounded. Appends past the live cap drop the oldest retained bytes; a reader below the retained window gets a lossy read, never an error. Settlement — the producer outcome, a kill, or teardown — trims retention to the settled cap and ends the stream; the record has no separate lifecycle.

```ts cordis-catalog
/**
 * Preflight access, validation, owner cleanup, and implementation-owned
 * admission before starting and atomically registering work. Any preflight
 * rejection leaves no job id or execution resource. A throwing starter
 * leaves nothing registered; after it returns, registration cannot fail.
 * Settlement records the outcome, notifies listeners, and releases waiters.
 * @param spec - job identity, owner, and synchronous starter.
 * @returns the registry-issued `<kind>-N` id.
 */
abstract start(spec: JobStart): JobId

/**
 * List caller-owned and unowned jobs in registration order without exposing
 * another session's labels.
 * @param caller - reading agent; a non-agent caller sees only unowned jobs.
 * @returns fresh snapshots.
 */
abstract list(caller?: Agent): JobSnapshot[]

/**
 * Return a non-consuming snapshot without changing its read cursor or notice
 * state. Throws for an unknown or foreign job.
 * @param id - job to look up.
 * @param caller - reading agent checked against the owner.
 * @returns a fresh snapshot.
 */
abstract get(id: JobId, caller?: Agent): JobSnapshot

/**
 * Read the next stream delta, or the idempotent final output after settlement.
 * A terminal read marks the job reported. Throws for an unknown or foreign
 * job.
 * @param id - job to read.
 * @param caller - reading agent checked against the owner.
 * @returns output text and the post-read snapshot.
 */
abstract read(id: JobId, caller?: Agent): JobRead

/**
 * Request cancellation, then mark the job stopping and reported. A producer
 * throw propagates without changing job state. Throws for an unknown or
 * foreign job.
 * @param id - job to cancel.
 * @param caller - killing agent checked against the owner.
 * @param reason - logged reason forwarded to the producer.
 * @returns `requested` for live work, otherwise `already-finished`.
 */
abstract kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished'

/**
 * Wait for settlement or timeout without cancelling the job. Caller abort
 * rejects only while the job is live; after settlement the terminal
 * snapshot wins so a notice suppressed for this waiter is still delivered.
 * Throws for invalid, unknown, or foreign input.
 * @param id - job to wait for.
 * @param timeoutMs - positive finite wait bound in milliseconds.
 * @param caller - waiting agent checked against the owner.
 * @param signal - optional cancellation of the wait itself.
 * @returns snapshot at settlement or timeout.
 */
abstract wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot>

/**
 * Register an effect-scoped completion listener. It receives the settlements
 * of the owners its registering context's scope covers; each listener is
 * contained; returned promises are observed but not awaited. No listener runs
 * after service disposal.
 * @param listener - receives each terminal snapshot and its exact owner.
 * @returns disposer that unregisters the listener.
 */
abstract onJobDone(listener: JobDoneListener): () => void

/**
 * Register an effect-scoped observer of visible-set changes. It fires after
 * every commit that changes what {@link list} returns for that owner —
 * registration, every stopping transition (including the one teardown
 * performs before it awaits a slow producer), settlement, owner-disposal
 * removal, and the emptying that service disposal commits — so an observer
 * re-reads rather than accumulating deltas.
 *
 * Delivery is owner-relative on the same terms as {@link onJobDone}: an
 * observer registered from an unscoped context — a host composition's own
 * carrier — sees every owner, while one registered under an agent
 * composition's scope sees exactly the agents composed under it.
 *
 * This is not a superset of {@link onJobDone}: that one delivers the terminal
 * record under first-wins semantics a job controller couples to notice
 * delivery, while this one carries no delivery meaning and marks nothing
 * reported. Listeners are contained and never awaited.
 * @param listener - receives the owner whose visible set changed, or
 *   `undefined` when an unowned job changed and every caller's set did.
 * @returns disposer that unregisters the listener.
 */
abstract onJobsChanged(listener: JobsChangedListener): () => void

/**
 * Read retained record output from an absolute byte offset without consuming
 * it. Resume by passing a previous read's `next`; a foreign offset inside a
 * retained chunk returns that whole chunk (its `at` may precede `from`).
 * Never marks the job reported. Throws for an unknown or foreign job, a job
 * without a {@link JobStart.record} declaration, or a negative or
 * non-integer offset.
 * @param id - job to read.
 * @param from - absolute byte offset to read from (0 for the retained head).
 * @param caller - reading agent checked against the owner.
 * @returns retained chunks overlapping `[from, total)`, the resume offset, and the lossy flag.
 */
abstract readRecord(id: JobId, from: number, caller?: Agent): JobRecordRead

/**
 * Register an effect-scoped observer of record advancement — one signal per
 * committed append and one at settlement, carrying only the job id. A
 * consumer schedules a {@link readRecord} from its own cursor; the registry
 * never pushes payloads. Delivery is owner-relative on the same terms as
 * {@link onJobsChanged}. Listeners are contained and never awaited.
 * @param listener - receives the id whose record advanced.
 * @returns disposer that unregisters the listener.
 */
abstract onOutput(listener: JobOutputListener): () => void

/**
 * Attach an effect-scoped controller that can read and stop jobs. It serves the
 * owners its registering context's scope covers, and {@link start} refuses an
 * owner no attached controller serves.
 * @param name - diagnostic label; duplicate names remain independent.
 * @returns disposer that detaches this controller.
 */
abstract attachController(name: string): () => void
```

Types: [Agent](core.zh.md)

Source: [`packages/jobs/jobs/src/index.ts`](../../packages/jobs/jobs/src/index.ts)
<!-- END GENERATED cordis-surface -->
