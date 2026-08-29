# Agent Note: 在 CPython 后端限制在途 binding 调用、快照 binding 元数据并压缩回复队列

Status: implemented

[English](2026-08-29-code-runtime-python-call-backlog-and-binding-metadata-snapshot.md) | 中文

## Problem

对 CPython 子进程后端（packages/experimental/code-runtime-python）的又一轮评审在 binding 分发与校验路径上浮出三项发现。其一，回复积压上限只计数已解析的调用——`pendingReplies` 在 binding 的 `await` 解析后才增长——因此向 promise 永不结算的 binding 洪泛调用的子进程会每个帧累积一个异步闭包直到墙钟，却始终不触发该上限。其二，`validateBindings` 多次读取 `errorClass.name`、`errorClass.memberNameProperty` 与 `namespace.global`，并把原始 errorClass 对象保留到引导帧，其 `JSON.stringify` 在校验后重读该对象：getter 在校验时返回合法值、在序列化时抛错或返回冲突值，会把 seam 误用拒绝变成 worker-exit，或注入一个未经校验批准的名字。其三，`replyQueue` 在排空进行中从不收缩：排空循环把已消费槽位清成 `undefined`，但 `length`（及其后备存储）继续增长，因此以恰好能让排空持续存活却永不排空的速率读取回复的子进程，会让数组随累计吞吐量线性增长。

## Decision

### 在途 binding 调用限制为 1024

`case 'call'` 在分发前对在途 binding 调用计数（`pendingCalls`），并在异步体的 `finally` 中释放槽位，覆盖回复已写入、解析被拒绝与结算后丢弃三种出口。计数达到 `MAX_PENDING_REPLIES` 时，运行以带 call-backlog 消息的 `worker-exit` 结算，与回复积压一样限制在途闭包。这是计数上限而非字节上限。

### binding 元数据在校验与引导帧之前快照为纯值

`validateBindings` 把 `namespace.global`、`errorClass.name` 与 `errorClass.memberNameProperty` 各恰好读取一次到普通局部变量，对副本做校验，并在 bindings 映射中存入普通 `{ name, memberNameProperty }` 对象。引导帧序列化该存储副本，因此无论 getter 处于何种状态，校验与引导帧看到的都是相同的值；有状态的 getter 无法在两个阶段之间改变或抛错。

### 回复队列在排空进行中压缩已消费前缀

`drainReplies` 在 `head` 达到 `MAX_PENDING_REPLIES` 时压缩已消费前缀（`replyQueue.splice(0, head); head = 0`）。该 splice 为 O(head)，每消费一上限的帧执行一次——均摊到每条回复为 O(1)——使永不排空的排空把后备存储限制在 O(积压 + 上限)。

## Testing

- `tests/runtime.spec.ts`——敌意子进程向永不结算的 binding（`await new Promise(() => {})`）洪泛 5000 个连续调用；运行在远早于 `maxWallMs` 时以带 call-backlog 消息的 `worker-exit` 结算。已实测失败前置：没有该上限时运行在墙钟处超时。
- 两个 namespace 形态测试——`errorClass.name`/`errorClass.memberNameProperty` 与 `namespace.global` 经由第二次读取即抛错或改变的 getter 暴露；运行正常引导并完成，且每个字段恰好读取一次（已断言）。已实测失败前置：没有快照时，errorClass getter 在校验内抛错，global getter 注入不同名字，程序以 `NameError` 失败。
- `tests/runtime.spec.ts`——子进程洪泛回复超过可写高水位线的调用，阻塞第一次排空写入；恢复的排空在第二波调用仍待发时消费超过压缩上限的积压，子进程直接读取 fd 3（阻塞回复泵）验证全部 1524 条回复送达。已实测失败前置：移除待发帧的 splice 会丢掉第二波回复，运行挂到墙钟。

## Alternatives considered

**暂停 fd-3 读侧而非计数在途调用。** 拒绝：暂停读取也会让子进程在最后一个调用后可能发送的 `done` 与 `log` 帧处理停滞，改变结算时机；计数上限是确定性的，且与既有帧上限模式一致。

**只读取一次元数据但保留原始 errorClass 对象。** 拒绝：引导帧的 `JSON.stringify` 会重新调用 getter；只有存入普通副本才能保证两个阶段读到相同的值。

**依赖排空的 `finally` 重置来回收队列内存。** 拒绝：重置只在排空结束时运行；永不排空的排空会持续增长。排空进行中的压缩在排空存活期间限制后备存储。

## Consequences

在途 binding 闭包与回复积压一样受限，向永不结算的 binding 洪泛调用的子进程会让运行提前失败，而不是把闭包累积到墙钟。引导帧序列化校验批准的元数据，与 getter 状态无关。回复队列的后备存储在持续的部分排空期间保持有界；压缩是内部内存卫生，无可观察的行为变化。
