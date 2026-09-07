# Agent Note: 持久的图片 offload 水位

Status: implemented

[English](2026-09-02-image-offload-watermark.md) | 中文

## 问题

请求级图片 offload 过去在每次请求时都从头重算。每条路由按最老优先的顺序收集派生表层上的全部图片出现位置，累计字节一旦超过预算，就把超出部分向上取整到整个删除量子，把这么多最老的出现位置替换为占位文本，见[统一图片请求管线](../feature/2026-08-20-unified-image-request-pipeline.zh.md)。没有任何东西记住上一次请求停在哪里，前缀稳定只是因为对 append-only 历史做同样的算术会得到同样的结果。

算术的输入一动，这种稳定就失效。[Files 内联回退](../../archived/bug-fix/2026-08-21-deepseek-files-inline-fallback.md)会用 20 MiB 内联预算和 10 MiB 量子重建请求，那一次省略多得多的图片，下一次 file 模式的请求又把它们带回来。pi-ai 路由的量子是一个字节，前缀几乎每次请求都会移动。compaction 降低总量，让先前省略的图片回归。切换路由会移动每个台阶边界。每一次移动都改变模型可见前缀，并让 provider 的缓存前缀失效。

同样的重算也破坏了仓库不变量：模型可见输入必须能从 session log 重建。实际发出的表示方式、派生请求版本的精确字节长度、路由预算和量子都是运行时或配置事实，从不进入日志，`request/header` 只记录调用配置、系统提示词和工具。provider usage 只锚定 token 总量，恢复不了图片集合，[按路由定价的估计](../../archived/feature/2026-08-24-route-priced-image-request-pressure.md)也写明它不复现回退预算。没有任何消费方能把一条已记录的助手响应和它的请求携带的图片集合配对。

## 决定

offload 位置是持久的会话事实：核心事件 `image/offload` 记录一条只会前进的图片 offload 水位，派生表层、每条路由和 token meter 都从它读取省略集合。

**事件。** `image/offload` 携带 `{ turn, step, watermark }`，其中 `watermark` 是一个 `ImageOccurrencePosition`：承载最后一个被省略出现位置的事件序号，以及它在该事件内容中的完整嵌套块路径。位置先按序号再按路径排序，所以无论表层如何替换，较新的事件总在较老的之后。`Session.deriveMessages()` 与 `Session.deriveEventMessage()` 把位于水位及之前的每个出现位置在 `ImageBlock` 上标为 `offloaded: true`；标记后的副本被冻结，持久事件内容不受影响。`Session.append` 与 seed 拒绝畸形或没有严格前进的水位，并要求路径指向当前表层中的图片。它们还会拒绝包含请求专用 `offloaded` 标记的持久消息。`session.imageOffloadWatermark()` 折叠最新的冻结位置。该事件改变派生表层，因此读取时必须识别；增加该事件不改变日志信封结构。

**只前进。** 预算变大、路由切换或 compaction 降低总量时水位永不回退，所以模型可见前缀和 provider 缓存前缀只向前移动。水位之下的出现位置后来被 compaction 遮蔽也不影响水位有效性，因为比较是按位置进行的。

**决定权在一个插件，预算由路由声明。** 支持图片的路由在其 `LlmResolvedModelInfo` 上以 `imageRequest` 声明一个 `LlmImageRequestBudget`（`representation`、`maxBytes`、`maxImages`、两个量子与请求版本字节目标）。`dsh-llm-image-offload` 插件监听 `agent/pre-step`：下游监听器决定进入 step 后，它通过 `ctx.llm.resolveModelInfo()` 解析最新 `request/header` 所指路由的预算，按模型请求顺序收集保留的出现位置，用纯函数 `offloadedImagePrefixCount()` 规划删除前缀（表示字节是归一化字节数按版本目标截断后的值，内联路由再按 base64 展开，按整量子删除）。表层替换可能把较新的事件放到较老事件之前；插件把请求前缀换算成其中最大的持久位置，因此可能额外省略一些出现位置，但一定满足要求的删除量。事件落在 `step/start` 之前，循环的常规派生因此发送已省略的集合。第一个 header 之前，以及进入的 step 自己追加的出现位置，不做规划，由下面的 adapter 失败路径覆盖。DeepSeek adapter 声明其 file 模式预算，pi-ai adapter 声明其 base64 上限；agent loop 不变。

**adapter 只投影，不决定。** 序列化把每个 `offloaded` 块渲染为带当前已解析访问路径的 `offloadedImageText`，只准备保留的出现位置。当保留的出现位置按精确请求版本字节仍超过路由预算，无论是 file 模式、内联回退更紧的预算还是 pi-ai 上限，adapter 都以 `IMAGE_OFFLOAD_REQUIRED` 让本次尝试失败，并在 `LlmFailure.offloadImages` 中用共享的 `requiredImageOffload()` 算出还需省略多少最老的出现位置。插件的 `agent/request-error` 监听器按该数量推进水位并返回 `retry` 动作，循环据此在派生表层上重跑该 step；没有可省略的出现位置时，监听器向下游委托，失败进入普通恢复路径。

**token 记账。** `priceImages` 接收表层的 `ImageBlock`，把 `offloaded` 的按占位文本定价；DeepSeek 和 replay 的定价不再复现任何 offload 算术。meter 把 `image/offload` 折进其重放状态，按当前水位为当前表层定价，按每个 usage 锚点的请求派生时的水位为该锚点定价。已完成请求仍以 provider usage 为锚点。

**其他消费方。** compaction 在直接调用 `ctx.llm.stream` 之前，通过 `Session.deriveEventMessage()` 重建每个选中事件，因此会应用与 `deriveMessages()` 相同的当前水位。resume、fork 和重放从日志复现表层。纯文本路由保留各自的全历史替换。

## 考虑过的替代方案

**继续每次请求重算 offload 位置。** 只在算术输入不动时稳定，内联回退、pi-ai 量子、compaction 和路由切换都会移动前缀，且没有消费方能重建历史请求的图片集合。

**用 log-only 事件记录每次请求的投影结果。** 恢复了可重建性但没有稳定性：记录的结果不是决策输入，每一种抖动照旧发生，日志只是把它记下来，且省略集合有两个可能不一致的事实来源。

**记录完整的投影后请求体。** 除 offload 决定外一切都已可派生，为记录一个位置而每次请求重复整段历史会让日志平方级增长。

**用附件 id 或出现次数标识水位。** 附件 id 在重复附加时重复，位置因此含糊；compaction 剪掉更早的出现位置后计数会漂移。序号加块路径没有歧义，也不受剪枝影响。

**让各个 adapter 自己追加事件。** adapter 拥有预算，但不拥有会话表层；在循环之下追加表层事实绕过了会话的派生历史，也会让两个 adapter 对表层做出不同定义。adapter 改为上报它需要的数量。

**在 agent loop 内部规划并推进。** 循环在派生每个请求之前就知道精确的已准备路由，在那里规划永远不会多花一次失败的尝试。但这会把一条路由专属的策略放进所有 profile 共用的那个组件，改变已记录的 step 顺序，还绕过了上下文溢出 compaction 和重试已经在用的同一套 `agent/request-error` waterfall。放在现有 `agent/pre-step` 与 `agent/request-error` 扩展点上的插件，只在 step 自己的消息或未知路由把保留集合推过预算时多花一次失败的尝试，循环保持不变。

**为内联回退和精确字节溢出保留临时的额外省略。** 恰好会在不变量所针对的场景发送未记录的投影；失败再推进的路径只多花一次序列化尝试，且让每个已发出请求都可由日志派生。

## 后果

预算变大、选中更大的路由或 compaction 降低总量时，被省略的图片不会自动回归；恢复手段是占位文本中的只读路径，模型需要时主动使用。一次 Files 故障或临时切到小预算路由会永久推进水位，两者出于同一理由被接受。

每个已发出请求的图片集合仅由日志决定，覆盖 file 模式、内联回退、resume、fork、retry 和 compaction，provider 缓存前缀不再抖动。占位和句柄文本中嵌入的执行世界访问路径仍在序列化时解析，这个缺口对保留的图片同样存在，属于另一个关于记录执行世界映射的决定。

## 测试

`packages/llm/llm/tests/content.spec.ts` 钉住任意深度的图片遍历、表示字节、投影和前缀计数，包括 129 到 64 MiB 的量子示例。`packages/core/session/tests/image-offload.spec.ts` 钉住追加与 seed 校验、当前表层图片路径、拒绝持久化派生标记、严格推进、任意深度标记、冻结副本、缓存重建和从头重放的一致性。`packages/llm/llm-image-offload/tests/image-offload.spec.ts` 钉住 step 前推进、不回退的水位、表层替换后的请求顺序计数、`IMAGE_OFFLOAD_REQUIRED` 的推进并重试路径以及向下游委托的耗尽情况。compaction 测试钉住直接摘要输入中的水位应用。adapter 测试钉住占位投影、只读取保留图片以及带数量的精确字节失败；`route-pricing.spec.ts` 钉住水位定价。`inline-image-prompt` TypeScript SDK 快照通过发布的 profile 重放一次手工编写的 `IMAGE_OFFLOAD_REQUIRED` 尝试，钉住推进和重试后的请求。Python SDK 通知测试钉住新事件及其嵌套水位的无损转发。
