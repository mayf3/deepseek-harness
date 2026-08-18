# Agent Note: 在会话历史中传输打包分片行

Status: implemented

[English](2026-08-15-packed-session-history-transport.md) | 中文

## 问题

`session.history` 与 `subagent.history` 会向远程客户端提供一段有界的逻辑会话事件区间。提供方流可能在一个未完成尾部中产生数十万个 token 大小的 `assistant/chunk` 事件。先展开每条持久化行，再序列化每个逻辑事件，会在协议中重复相同信封；浏览器再次展开每条记录，则会在 conversation 折叠拼接文本之前重建同样的对象扩散。

传输必须保持无损。会话序号是分页与重连证据；精确 token 边界对诊断和非 UI API 消费方仍然有用；实时流式传输、持久导出、回放与模型历史派生仍然需要规范事件流。如果由服务端 transcript 投影丢弃已完成步骤的分片，API 证据就会取决于一项 UI 策略。

## 决策

历史方法返回 `records: HistoryRecord[]`，以及包含端 `fromSeq` 与不包含端 `toSeq` 水位。普通记录携带 `{event, view?}`。连续且属于同一块的 Assistant delta 事件使用[打包 JSONL 决策](2026-07-26-packed-chunk-rows-by-default.zh.md)中的共享无损编解码器，携带 `{chunks: ChunkRow}`。系统先从逻辑事件中选择页面，再执行打包，因此按消息对齐的分页不依赖物理持久化布局。

协议 schema 校验每一行，拒绝不安全的重建，并要求记录无间隙、无重叠地精确覆盖 `[fromSeq, toSeq)`。更早页面拼接、重连修复与实时事件去重以水位为准，而不以浏览器折叠输入的数量或可见 seq 邻接关系为准。`session.history` 与 `subagent.history` 共用相同的响应 schema。

普通浏览器 UI 不会把打包行解码成每个 token 一个对象。它会把一行合并成最多两个 `assistant/chunk` 输入，同时保留累计内容、首个非空 token 时间戳，以及这两个边界不同时较晚出现的首个非空白可见时间戳。工具调用行保留调用身份、名称存在性、拼接后的参数片段与首 token 时间。其他 API 消费方在需要精确 token 边界时可以调用 `decodeStorageRecord()`。

实时 `session/event` 帧仍是单个事件。会话持久化、原始导出、回放、模型历史派生与规范内存日志均不改变。

## 测量结果

测量使用了一份生产规模的私有会话样本，未保留或签入其内容。其尾页包含 416,756 个逻辑事件。无损打包响应使用 696 条顶层记录，其中包含 116 条打包行。

| 表示 | 顶层记录数 | JSON 字节 | gzip 字节 | Brotli 字节 |
| --- | ---: | ---: | ---: | ---: |
| 原始逻辑事件 | 416,756 | 69,433,638 | 4,190,226 | 1,972,998 |
| 已完成步骤投影候选 | 228,129 | 38,427,209 | 2,324,688 | 957,350 |
| 无损打包历史 | 696 | 6,362,724 | 1,154,206 | 528,145 |

与原始逻辑事件相比，打包使未压缩 JSON 减少 90.8%；与有损的已完成步骤投影候选相比减少 83.4%。Brotli 输出相对原始形式减少 73.2%，相对该投影候选减少 44.8%。这些数字描述该样本，并非协议保证；收益随 delta run 的长度与规律性变化。

可选运行的 `packages/client/runtime/tests/history-transport.perf.client.ts` benchmark 使用合成内容构造相同的逻辑事件数、普通事件数与 delta run 数。`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.perf.config.ts packages/client/runtime/tests/history-transport.perf.client.ts` 会在 `HISTORY_TRANSPORT_PERF_RESULT` 下报告协议体积、Host／client 计时与采样的额外 V8 堆峰值。堆测量会在三次运行前强制执行垃圾回收，并相对于相同的已初始化 benchmark 状态，报告 Host 构造／序列化或 Client 解析／校验／准备／折叠各主要阶段之后所观察峰值的中位数。该指标不测量进程 RSS，也可能遗漏单个采样阶段内部的瞬态峰值。CI 不执行这组手动性能用例，其中也没有依赖机器性能的耗时或内存断言；结构断言固定 fixture 的事件规模、紧凑输入数，以及双消费方 Assistant 折叠 fixture 的一致最终状态。

## 曾考虑的替代方案

**在 Host 丢弃已完成步骤的分片。** 这会减少逻辑事件数，但会让传输语义取决于当前 transcript 策略，从所有消费方移除精确证据，同时仍把保留的未完成步骤 token 逐个装入信封。实测打包响应在保持无损的同时更小。

**发送打包行，再在浏览器展开每个成员。** 这会移除网络上的重复 JSON 信封，却会在生成相同累计 UI 状态之前，重建数十万个事件对象、折叠匹配与临时数组。

**只依赖 HTTP 内容编码。** gzip 与 Brotli 会减少网络字节，但不会移除重复的 JSON 解析、校验、分配与折叠工作。在实测样本中，打包行经过这两种编码后仍然显著更小。

**直接按物理持久化行分页。** 这还可以避免冷 Host 读取时的逻辑展开，但页面切分取决于追加来源消息与替换 provenance，而不是后端行边界。当前决策让 API 保持对 JSONL、SQLite 与未来持久化布局的独立性。

**只返回组装后的 Assistant 快照。** [仅保留组装消息的否决记录](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.zh.md)仍然适用：final message 之外的事件族承载用户可见状态与诊断状态，未完成步骤也需要其实际累计分片。

## 后果

历史响应保留每个逻辑事件，同时减少长 delta run 的协议字节、客户端 JSON 对象与普通 conversation 折叠工作。分页与重连逻辑使用显式原始区间水位，因此紧凑浏览器输入不会产生伪间隙。现有消费方必须从 `events` 切换到 `HistoryRecord` 联合，并明确选择紧凑 UI 折叠或精确解码。

冷持久历史仍会先解码成完整的逻辑 `SessionEvent[]`，Host 再选择页面并重新打包。因此，本决策改善的是传输与浏览器工作，不是 Host 冷读取的解码内存。消除该展开需要提供方无关的消息边界索引或单独的流式页面读取器，属于另一项优化。

历史回放不再为每个原始 token 重现一次 UI 更新。浏览器本就会批量安装历史，而不会为过去的 token 播放动画；settled view 使用的内容与计时边界仍会保留。实时流式行为不变。
