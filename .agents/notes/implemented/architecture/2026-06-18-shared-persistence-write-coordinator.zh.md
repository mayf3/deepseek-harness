# Agent Note: 共享持久化写入协调器

Status: implemented

[English](2026-06-18-shared-persistence-write-coordinator.md) | 中文

## 问题

JSONL provider 需要在其存储原语周围执行对正确性要求很高的写入编排：逐 Session 状态、`session/created` 接管、前缀读取、write-behind 控制、按 id 串行执行、HMR 种子注入与 dispose 排空。把该生命周期放在 Service Definition 中，可以避免仓库外 provider 重复实现。已删除的 first-party 数据库 provider 证明了这种重复成本；其删除由 [JSONL-only 持久化决策](../simplification/2026-08-30-jsonl-only-session-persistence.zh.md)负责。

## 决策

`dsh-session-persistence` 导出后端无关的 `PersistenceCoordinator`。JSONL provider 组合一个协调器实例（`new PersistenceCoordinator(ctx, this)`）、实现小型 `PersistenceBackend` 钩子接口，并把有状态公开方法（`create`/`append`/`prepare`/`load`/`inspect`/`readFrom`）委托给协调器。由后端拥有的元数据与修订版本列举会绕过协调器。

组合，而非继承。协调器是后端持有的具体类，不是后端继承的基类。协调器让非常规后端与继承层级作斗争的风险由此规避：后端只暴露钩子，无法触及协调器的私有编排状态。第三方后端仍然可以完全不使用协调器、直接实现抽象服务，包括不可变逻辑检查，以及通过 `load` 实现的默认准备回退。

协调器为每个存活的 `Session` 实例持有一个生命周期条目：初始化，加上一个包私有写入控制器，后者负责待处理事件、固定批处理截止时间、活跃写入、失败保留和共享 flush 屏障。每个 `session/event` 都进入这条有界写入路径，`session/flush` 则绕过等待以观察完全停稳。控制器归并由 [flush 控制器简化](../simplification/2026-07-23-collapse-persistence-flush-state.zh.md)定义；调度节奏由[有界批处理决策](2026-08-08-bounded-session-persistence-write-batching.zh.md)定义。

创建流程将 `Session.events` 的原始快照借作持久化种子。`Session` 已经分离、验证并深度冻结每个事件，后续追加会替换缓存视图，因此该快照数组保持稳定。协调器及其后端钩子只读取这个有类型的进程内值；再次克隆完整日志会重复 [agent scope 运行时决策](2026-07-12-agent-scope-runtime-design.zh.md#session-append-materialize-validate-commit-notify)规定的所有权工作。持久化服务的公开 `append()` 仍在 API 边界为调用方拥有的输入创建快照。

已准备 Session 的后缀，以及进入 write-behind 队列的事件，仍保留现有复制。这些路径会逐个后缀或事件建立异步队列所有权，且没有已测得的完整日志克隆成本；移除这些复制属于单独的所有权审计，不属于创建种子的借用决策。

协调器通过 `session/disposed` 退役会话：它等待控制器完成初始化和当前 flush，串行执行最后一次排空，且仅在成功后才移除控制器与其拥有的每 id 状态。失败时保持控制器可被找到，以供后端 teardown（拆除）重试。每个 id 的已结算链尾仅在其仍是当前链尾时才移除自身，因此旧操作完成后不会抹除同一 id 的新操作。后端 teardown 会注销写入路径监听器、flush 每个剩余的控制器、等待所有按 id 串行化的操作，最后关闭后端。

### 钩子接口（`PersistenceBackend<TornMarker>`）

六个必需的持久原语，加上可选的格式融合、seek、空会话物化、产物与生命周期钩子，构成协调器与存储之间唯一的边界：

- `name` 标记聚合 dispose 失败；`loadStored(id)` 读取一个已经是当前格式的分离前缀；`readStoredRevision(id)` 返回其低成本来源标识。协调器会断言 id，并在修复或发布状态之前拒绝存储记录与活动会话的 cwd 不匹配。
- `ensureCurrent?(id)` 让后端在当前格式读取前发布任何受支持历史 generation 的当前后继。`loadCurrentStored?(id)` 把该操作与基于一个稳定选定 generation 快照的前缀解码融合；否则协调器依次调用 `ensureCurrent` 与 `loadStored`。原始产物通过 `readCurrentRawStored?` 与 `readRawStored?` 使用同一分工。
- `loadStoredFrom?(id, fromSeq)` 是可选的可 seek 当前格式后缀读取。顺序后端省略它并复用完整当前前缀。
- `appendBatch(meta, events, isMaterialized)` 持久追加一个连续批次，并原子执行惰性首次物化。`materializeHeader?(meta)` 为 [标准 ACP 自动化控制](../feature/2026-08-22-standard-acp-automation-controls.zh.md)这类生命周期前端显式持久化空的可恢复 Session。
- `commitRepair(meta, tornMarker, closers)` 在存在 torn tail 时截断它，在存在 closer 时追加它，从而持久化崩溃修复。它不要求原子性：JSONL 合理地分两步同步，先截断再追加。准备与加载提交截断和合成 closer；活动接管只提交截断。
- `list()` 为每个存储产物返回一个仅 header descriptor；`locate?()` 不经 I/O 解析后端拥有的产物；`close?()` 在协调器排空至完全停稳后释放后端资源。

### 不透明的 torn marker

保持 seam 整洁的唯一设计选择：崩溃修复中「损坏尾部在哪里」的 token 对协调器是不透明的。协调器计算合成收尾事件（它拥有来自 `dsh-session` 的 `interruptedTurnClosers`），但只测试 `tornMarker !== undefined` 并将值原样传回 `commitRepair`，从不检视其内容。JSONL 携带要截断到的字节偏移，以及从不完整最终帧中解码出的任何完整事件；其他 provider 可以选择自己的 marker 类型。协调器因此既不了解字节长度，也不了解帧恢复状态。

## 测试

共享 `runPersistenceContract` 证明已经是当前格式的 JSONL `inspect` 会配平被中断的逻辑视图但不改变存储或 revision，随后由 `prepare` 或 `load` 提交恢复；受支持的历史检查会先在不改变源文件的情况下于其旁边发布迁移并修复后的当前后继。`runCoordinatorContract`（`tests/coordinator-contract.ts`）通过内存参考实现与 JSONL 覆盖接管、HMR、碰撞、Session 与 provider dispose 排空和崩溃尾部修复。`persistence.spec.ts`、`preparations.spec.ts` 与 `write-behind.spec.ts` 覆盖准备复用与预留、有界准备状态淘汰、固定窗口后续批次、存活 controller 清理、同 id 链尾竞态、失败批次重试与关闭顺序。JSONL spec 保留存储机制，以及覆盖不透明 marker 分支的经由协调器崩溃尾部用例。

## 曾考虑的替代方案

- **后端继承的基类**——否决，改用组合：后端只暴露钩子，无法触及协调器的私有编排状态，且第三方后端仍可完全不使用协调器、直接实现抽象服务。
- **把历史格式放入协调器，或要求两次物理读取**——不予采用，因为格式 framing、最高 generation 选择、不可变后继发布与稳定来源解码属于后端。可选的融合当前格式读取保留一个协调器生命周期，同时让 JSONL 对同一个精确快照完成分类或迁移与解码；普通钩子继续作为其他后端的 fallback。

## 后果

协调器增加一层间接、一个不透明 torn marker、脱离 Session 生命周期的退役任务，以及有界的已准备 Session 状态，但为 JSONL provider 与未来实现集中管理对正确性要求很高的编排。Session dispose 仍是仅观察事件，因此 Session owner 不等待持久化退役；协调器收容失败、在活动 controller 中保留待处理事件，并以 provider teardown 为完全停稳边界。其钩子只服务当前 consumer：标识、接管、碰撞检查、准备与不可变检查共用串行化当前前缀路径；物化保持在 `appendBatch` 内原子完成；列举绕过有状态编排。对已经是当前格式的输入，读模型使用 `inspect` 而非 `load`，因此观察开放轮次时不会提交中断 closer；历史输入会先发布一个独立的迁移并修复后继。复用、预留与发布由 [Session 准备阶段决策](2026-08-05-session-preparation.zh.md)定义。新 provider 只需实现存储原语，而无需复制有界写入生命周期。
