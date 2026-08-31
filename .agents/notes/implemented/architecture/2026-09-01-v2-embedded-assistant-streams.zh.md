# Agent Note: 在 v2 attempt settlement 中嵌入 Assistant stream

Status: implemented

[English](2026-09-01-v2-embedded-assistant-streams.md) | 中文

## 问题

Token 粒度的 `assistant/chunk` 事件会保留精确的 stream 顺序、时间、usage、terminal state、replay metadata 与失败时的部分输出，但让每个 chunk 成为顶层 Session event 会在持久化、遥测、历史传输、索引和 Client 组装中重复信封。物理 packed row 可以减少 JSONL 字节，却不会减少逻辑事件数，也不会减少接收规范 stream 的消费方工作量。

只存储组装后的成功 message 可以消除这些开销，但会丢失失败与放弃的输出、token 边界、时间戳和确定性 provider replay。持久记录需要让每个模型 attempt 只占一个单位，同时不减少 replay、诊断、取消恢复、usage 记账、snapshot 与 UI 历史依赖的证据。

改变事件基数也会改变 Session 序号。已发布迁移必须保留无关事件的相对顺序、改写每个已声明的同 Session 引用、保留精确 fork 切点，并拒绝任何无法保持语义的关系。

## 决策

Session format v2 没有顶层 `assistant/chunk` 事件。每个模型 attempt 提交一个包含 `stream: AssistantStreamRecord[]` 的持久 settlement：

- `assistant/message` 是成功响应或具有可见组装内容的已取消响应所对应的 surface settlement。它在组装 message 旁嵌入精确的紧凑带时间 stream、可选 usage 与可选 `interrupted: true` marker。
- `assistant/attempt` 只进入日志。它保留失败、重试、取消或崩溃尾部 attempt 的 stream；这些 attempt 没有提交 surface message，因此诊断与记账不会虚构模型可见历史。

`AssistantStreamAccumulator` 对每个 chunk 只快照一次。同一 block 的连续 text、reasoning 或 tool argument delta 会变成一个紧凑 run，包含首个时间戳、精确时间戳间隔和每个原始 delta 对应的一个数组成员。其他 chunk 保留为带时间戳的 raw record。`expandAssistantStream()` 会严格校验并重建精确的带时间序列；压缩绝不会合并 delta 边界。

当前 v2 校验器要求嵌入式 stream 能复现非空 `assistant/message` 的 content、usage 与 replay state。对于没有源 chunk 的已迁移旧 message，空 stream 仍然有效。`assistant/message` 不能携带已停用的 chunk `sourceEventSeqs`；普通 user 与 tool surface provenance 保持可用。

### 实时呈现与持久回放

`agent/assistant-stream` 发布进程本地 start、瞬态 chunk 与 end frame。loop 会在 committed end frame 命名其类型和序号前追加完整的 `assistant/message` 或 `assistant/attempt`。abandoned end 没有 settlement。

Web follow adapter 显式选择接收这些无 cursor frame。它把 chunk 呈现为持久 cursor 之间的 Client-only `assistant/live-chunk` update，把匹配的 settlement 暂存到 committed end，并在 revision 缺口时重新打开 follow。重连 baseline 携带活跃 attempt 的紧凑前缀。分页历史、replay、遥测、token 记账与冷 UI 组装读取持久嵌入式 stream，而不是 live frame。

### 已发布 v1 到 v2 迁移

相邻迁移会校验完整的冻结 v1 产物，按 turn、step、terminal boundary 与精确 message provenance 对 chunk 分组，再为每个 attempt 替换一个 settlement。成功分组的 chunk 移入其 message。未被认领的分组会在最后一个被消费 chunk 的位置变成 `assistant/attempt`。无关的交错事件保持相对顺序，存活事件获得密集 v2 序号。

该迁移边会重映射有限的已声明引用清单：信封 provenance、surface replacement 端点、command source event、compaction range 与 shadowed list，以及 title message list。指向被消费 chunk 的引用会使迁移失败；它绝不会被重定向到含义不同的 settlement。该迁移边也会拒绝切开 attempt 的继承切点。

v2 物理 header 要求 `isSeeded`，且不存储数值切点。带 seed 的产物用 `session/end-seed { inherited: true }` 标记其精确切点；解码从最后一个 tagged marker 推导切点。v2 编解码器为每个持久事件写一条物理行，并且只对 `sourceEventSeqs` 做范围编码。冻结的 v0 与 v1 编解码器继续为不可变历史 generation 解码 packed row。

Generation 选择与发布遵循[已发布 Session 迁移决策](2026-08-31-released-session-format-migrations.zh.md)：源路径、字节与 inode 保持不变，只发布最终具名版本 successor；保留 predecessor 不提供 fallback 或 downgrade 支持。

## 验证

紧凑 stream 测试固定 text、reasoning、tool argument、raw chunk、时间戳间隔、格式错误 record 与分离 snapshot 的精确累积和展开。v1 到 v2 测试覆盖成功与失败 attempt、交错、密集序号与引用重映射、seed 切点插入与切分拒绝、严格源与目标校验、每行一个事件的 v2 编码、provenance range、原始与 Zstandard 发布，以及无写入的当前读取。

手工 performance acceptance 会在三轮、100 组 warmup pair 与 600 组 measured pair 下，把当前 v2 catalog dispatch 与同一物理输入的 direct-current 读取比较。它要求每个 pooled median 与 p95 regression 保持在 5% 以内；已接受运行的最差 p95 regression 为 2.201%。`--smoke` 报告不参与 gate 的诊断 sample。

Agent-loop 测试固定先持久后 end 的顺序、中断的可见前缀、失败与重试 attempt、abandonment、usage 与 replay metadata。Session Controller 与 Conversation 测试固定实时瞬态显示、重连 baseline、committed settlement 发布、历史回放以及 Chat 与 Trajectory 一致性；TypeScript 与 Python SDK snapshot 固定外部事件表示。

## 备选方案

**只持久化组装后的成功 message。** 这会丢失部分失败输出、时间、token 边界、没有 message 的 attempt usage，以及精确确定性 replay。`assistant/attempt` 与嵌入式紧凑 stream 会保留这些事实，且不把它们加入模型历史。

**保留顶层 chunk，只打包物理行。** 这会保留 v1 逻辑表示，却让序号密度、遥测量、wire 信封、Client entry 与消费方 dispatch 继续与 token 数成正比。历史编解码器仍然解码该表示；它不是当前事件模型。

**通过历史 API 传递 packed chunk row。** 这会减少 v1 的 wire 与 Client 工作，却让 Client 拥有第二套事件词汇，并让传输继续与 token-row 基数耦合。当前 API 携带标量持久 settlement，并使用独立的实时瞬态 stream。

**把 stream 存在 sidecar 或 replay-only fixture 中。** 这会把一个 attempt 的 message 与证据拆给不同持久性 owner，也无法让普通恢复 Session 获得相同的失败输出与时间事实。settlement 是原子 owner。

**把被消费 chunk 的引用重定向到其 settlement。** Chunk 与 attempt settlement 不是可互换事实。拒绝可以防止迁移悄然改变插件自有引用的含义。

## 后果

当前日志、遥测、历史页与冷 Client 组装按模型 attempt 而非 token chunk 扩展，同时在每个 settlement 内保留精确 stream 证据。实时呈现保持增量，并且有意仅存在于进程内。

一个 settlement 可能很大，v1 到 v2 迁移会物化完整产物及其序号映射。封闭的 Alpha 清单会拒绝未知 v1 事件与未声明引用，而不会猜测。需要单独 chunk 的消费方调用 `expandAssistantStream()`，并且绝不能从 `agent/assistant-stream` 推断持久性。

迁移会改变被消费 v1 chunk 之后的序号，因此每个同 Session 引用都必须属于显式改写规则。该约束有意让未来的基数变化迁移保持昂贵，并防止格式链执行无声的语义重定向。
