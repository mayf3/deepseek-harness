# Agent Note: 在会话历史中传输打包分片行

Status: implemented

[English](2026-08-15-packed-session-history-transport.md) | 中文

## 问题

`session.page` 会向远程客户端提供一段有界的逻辑会话事件区间。提供方流可能在一个未完成尾部中产生数十万个 token 大小的 `assistant/chunk` 事件。先展开每条持久化行，再序列化每个逻辑事件，会在协议中重复相同信封，并让浏览器在 conversation 回放开始前解析和校验这些重复内容。

传输必须保持无损。会话序号是分页与重连证据；精确 token 边界对诊断和非 UI API 消费方仍然有用；实时流式传输、持久导出、回放与模型历史派生仍然需要规范事件流。如果由服务端 transcript 投影丢弃已完成步骤的分片，API 证据就会取决于一项 UI 策略。

## 决策

`session.page` 返回 `records: SessionHistoryRecord[]`。普通记录携带 `{event}`。连续且属于同一块的 Assistant delta 事件使用[打包 JSONL 决策](2026-07-26-packed-chunk-rows-by-default.zh.md)中的共享无损编解码器，携带 `{chunks: ChunkRow}`。系统先从逻辑事件中选择页面，再执行打包，因此按消息对齐的分页不依赖物理持久化布局。

生成的 Remote decoder 会校验响应字段，共享的行 decoder 会拒绝格式错误的行，以及不安全的序号或时间戳重建。`SessionEventStream` 会先展开记录，再将其交给 `RemoteJournalStream`；因此 journal 会依据原始事件序号检查页面连续性、分页拼接、重连修复和实时事件去重。页面请求中的 durable address 既可选择普通 Session，也可选择已授权的 direct subagent child，无需第二套历史协议。

Client adapter 会先调用共享的 `decodeStorageRecord()` 编解码器，再向 Session 对象层发布页面。每个打包成员都会还原为完全一致的原始 `assistant/chunk` 事件，包括 `seq`、时间戳、chunk 类型、block 索引、文本或参数片段、调用身份，以及可选名称是否存在。因此，已注册的 `ConversationNodeDefinition` 会对每个历史 delta 收到一次 `match()` 调用，并按实时事件所具有的同一 start／update 顺序折叠已接受的 match。打包只改变传输编码，不改变公共 Definition 的回放语义。

实时 `session.follow` 帧仍是单个事件。会话持久化、原始导出、回放、模型历史派生与规范内存日志均不改变。

## 测量结果

测量使用了一份生产规模的私有会话样本，未保留或签入其内容。其尾页包含 416,756 个逻辑事件。无损打包响应使用 696 条顶层记录，其中包含 116 条打包行。

| 表示 | 顶层记录数 | JSON 字节 | gzip 字节 | Brotli 字节 |
| --- | ---: | ---: | ---: | ---: |
| 原始逻辑事件 | 416,756 | 69,433,638 | 4,190,226 | 1,972,998 |
| 已完成步骤投影候选 | 228,129 | 38,427,209 | 2,324,688 | 957,350 |
| 无损打包历史 | 696 | 6,362,724 | 1,154,206 | 528,145 |

与原始逻辑事件相比，打包使未压缩 JSON 减少 90.8%；与有损的已完成步骤投影候选相比减少 83.4%。Brotli 输出相对原始形式减少 73.2%，相对该投影候选减少 44.8%。这些数字描述该样本，并非协议保证；收益随 delta run 的长度与规律性变化。

可选运行的 `packages/client/ui-conversation/tests/history-transport.perf.client.ts` benchmark 使用合成内容构造相同的逻辑事件数、普通事件数与 delta run 数。`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.perf.config.ts packages/client/ui-conversation/tests/history-transport.perf.client.ts` 会在 `HISTORY_TRANSPORT_PERF_RESULT` 下报告协议体积、Host／client 计时、未压缩且采用 chunked response 的 Node loopback 传输中位数、组合后的合成 API 等待／UI 就绪时间，以及采样的额外 V8 堆峰值；第二组清单会在 `HISTORY_WHITESPACE_PREFIX_PERF_RESULT` 下报告 10,000、20,000 与 40,000 个成员 run 各五次精确解码的中位数。组合计时从内存事件数组开始，不包含冷持久化读取、projection 工作、生产 API bridge 与 RPC 信封，也不包含 Chromium 调度，因此它是对比清单，而非生产环境 wall-clock 延迟。堆测量会在三次运行前强制执行垃圾回收，并相对于相同的已初始化 benchmark 状态，报告 Host 构造／序列化或 Client 解析／校验／解码／折叠各主要阶段之后所观察峰值的中位数；该指标不测量进程 RSS、external 或 ArrayBuffer 内存，也可能遗漏单个采样阶段内部的瞬态峰值。CI 不执行这组手动性能用例，其中也没有依赖机器性能的耗时或内存断言；结构断言固定 fixture 的事件规模、精确解码事件数，以及双消费方 Assistant 折叠 fixture 的一致最终状态，包括 delta 数量与末个 delta 序号。

## 曾考虑的替代方案

**在 Host 丢弃已完成步骤的分片。** 这会减少逻辑事件数，但会让传输语义取决于当前 transcript 策略，从所有消费方移除精确证据，同时仍把保留的未完成步骤 token 逐个装入信封。实测打包响应在保持无损的同时更小。

**在已注册 Definition 看到打包 run 前先进行合并。** 这会减少浏览器事件对象与折叠调用，但开放的 `ConversationNodeDefinition` 可能统计 delta、检查各自的 `seq` 或时间戳，或者根据片段边界派生状态。累计文本相同不代表这些状态机等价，因此传输不能改变其回放输入数量。

**只依赖 HTTP 内容编码。** gzip 与 Brotli 会减少网络字节，但不会移除重复的 JSON 解析与校验。在实测样本中，打包行经过这两种编码后仍然显著更小；精确浏览器回放则保留契约要求的分配与折叠工作。

**直接按物理持久化行分页。** 这还可以避免冷 Host 读取时的逻辑展开，但页面切分取决于追加来源消息与替换 provenance，而不是后端行边界。当前决策让 API 保持对 JSONL、SQLite 与未来持久化布局的独立性。

**只返回组装后的 Assistant 快照。** [仅保留组装消息的否决记录](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.zh.md)仍然适用：final message 之外的事件族承载用户可见状态与诊断状态，未完成步骤也需要其实际累计分片。

## 后果

历史响应保留每个逻辑事件，同时减少长 delta run 的协议字节、Host 响应序列化与堆占用，以及浏览器 JSON 解析与校验工作。Journal 会在精确展开后校验连续性，因此打包传输记录不会产生伪间隙。`SessionEventStream` 消费方继续收到普通事件条目；直接调用 `session.page` 的消费方必须读取 `SessionHistoryRecord` 联合，并在逐事件处理前解码打包行。

冷持久历史仍会先解码成完整的逻辑 `SessionEvent[]`，Host 再选择页面并重新打包。因此，本决策改善的是传输与浏览器工作，不是 Host 冷读取的解码内存。消除该展开需要提供方无关的消息边界索引或单独的流式页面读取器，属于另一项优化。

浏览器历史回放仍会为每个原始 token 分配和折叠一个事件，因此本决策不会减少 Definition 的 match／update 次数或 settled history 堆占用；打包记录与展开事件同时存在时，还可能增加少量解码期峰值。历史仍作为一个批次安装，而不会为旧 token 播放动画；实时流式行为不变。
