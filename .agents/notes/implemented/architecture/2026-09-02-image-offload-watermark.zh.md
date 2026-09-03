# Agent Note: 持久的图片 offload 水位

Status: implemented

[English](2026-09-02-image-offload-watermark.md) | 中文

## 问题

请求级图片 offload 过去在每次请求时都从头重算。每条路由按最老优先的顺序收集派生表层上的全部图片出现位置，累计字节一旦超过预算，就把超出部分向上取整到整个删除量子，把这么多最老的出现位置替换为占位文本，见[统一图片请求管线](../feature/2026-08-20-unified-image-request-pipeline.zh.md)。没有任何东西记住上一次请求停在哪里，前缀稳定只是因为对 append-only 历史做同样的算术会得到同样的结果。

算术的输入一动，这种稳定就失效。[Files 内联回退](../bug-fix/2026-08-21-deepseek-files-inline-fallback.zh.md)会用 20 MiB 内联预算和 10 MiB 量子重建请求，那一次省略多得多的图片，下一次 file 模式的请求又把它们带回来。pi-ai 路由的量子是一个字节，前缀几乎每次请求都会移动。compaction 降低总量，让先前省略的图片回归。切换路由会移动每个台阶边界。每一次移动都改变模型可见前缀，并让 provider 的缓存前缀失效。

同样的重算也破坏了仓库不变量：模型可见输入必须能从 session log 重建。实际发出的表示方式、派生请求版本的精确字节长度、路由预算和量子都是运行时或配置事实，从不进入日志，`request/header` 只记录调用配置、系统提示词和工具。provider usage 只锚定 token 总量，恢复不了图片集合，[按路由定价的估计](../feature/2026-08-24-route-priced-image-request-pressure.zh.md)也写明它不复现回退预算。没有任何消费方能把一条已记录的助手响应和它的请求携带的图片集合配对。

## 决定

offload 位置是持久的会话事实：核心事件 `image/offload` 记录一条只会前进的图片 offload 水位，派生表层、每条路由和 token meter 都从它读取省略集合。

**事件。** `image/offload` 携带 `{ turn, step, watermark }`，其中 `watermark` 是一个 `ImageOccurrencePosition`：承载最后一个被省略出现位置的事件序号，以及它在该事件内容中的块路径（顶层块下标，再是工具结果块内的下标）。位置先按序号再按路径排序，所以无论表层如何替换，较新的事件总在较老的之后。`Session.deriveMessages()` 把位于水位及之前的每个出现位置在 `ImageBlock` 上标为 `offloaded: true`；标记后的副本被冻结，持久事件内容不受影响。`Session.append` 与 seed 拒绝畸形、指向日志之外事件或没有严格越过前一条的水位；`session.imageOffloadWatermark()` 折叠最新值。该事件改变派生表层，因此读取时必须识别；日志结构没有变化，`SESSION_FORMAT_VERSION` 保持不变。

**只前进。** 预算变大、路由切换或 compaction 降低总量时水位永不回退，所以模型可见前缀和 provider 缓存前缀只向前移动。水位之下的出现位置后来被 compaction 遮蔽也不影响水位有效性，因为比较是按位置进行的。

**决定权在循环，预算由路由声明。** 支持图片的路由在其 `LlmResolvedModelInfo` 上以 `imageRequest` 声明一个 `LlmImageRequestBudget`（`representation`、`maxBytes`、`maxImages`、两个量子与请求版本字节目标）；`LlmRuntime` 校验它并通过 `PreparedLlmCall` 暴露。`request/header` 之后，`buildRequest` 按日志顺序从表层收集保留的出现位置，用纯函数 `planImageOffload()` 规划推进（表示字节是归一化字节数按版本目标截断后的值，内联路由再按 base64 展开，按整量子删除），追加事件，然后才派生请求消息。DeepSeek adapter 声明其 file 模式预算，pi-ai adapter 声明其 base64 上限，replay adapter 为 keyless 场景声明可选的 `imageRequestMaxBytes`。

**adapter 只投影，不决定。** 序列化把每个 `offloaded` 块渲染为带当前已解析访问路径的 `offloadedImageText`，只准备保留的出现位置。当保留的出现位置按精确请求版本字节仍超过路由预算，无论是 file 模式、内联回退更紧的预算还是 pi-ai 上限，adapter 都以 `IMAGE_OFFLOAD_REQUIRED` 让本次尝试失败，并在 `LlmFailure.offloadImages` 中用 `offloadedImagePrefixCount()` 算出还需省略多少最老的出现位置。循环按该数量推进水位并在 `agent/request-error` 运行前重建请求；没有可省略的出现位置时，失败进入普通恢复路径。

**token 记账。** `priceImages` 接收表层的 `ImageBlock`，把 `offloaded` 的按占位文本定价；DeepSeek 和 replay 的定价不再复现任何 offload 算术。meter 把 `image/offload` 折进其重放状态，按当前水位为当前表层定价，按每个 usage 锚点的请求派生时的水位为该锚点定价。已完成请求仍以 provider usage 为锚点。

**其他消费方。** compaction 摘要和其他所有 `ctx.llm.stream` 调用方都从同一表层派生，因此只读取水位、从不推进。resume、fork 和重放从日志复现表层。纯文本路由保留各自的全历史替换。

## 考虑过的替代方案

**继续每次请求重算 offload 位置。** 只在算术输入不动时稳定，内联回退、pi-ai 量子、compaction 和路由切换都会移动前缀，且没有消费方能重建历史请求的图片集合。

**用 log-only 事件记录每次请求的投影结果。** 恢复了可重建性但没有稳定性：记录的结果不是决策输入，每一种抖动照旧发生，日志只是把它记下来，且省略集合有两个可能不一致的事实来源。

**记录完整的投影后请求体。** 除 offload 决定外一切都已可派生，为记录一个位置而每次请求重复整段历史会让日志平方级增长。

**用附件 id 或出现次数标识水位。** 附件 id 在重复附加时重复，位置因此含糊；compaction 剪掉更早的出现位置后计数会漂移。序号加块路径没有歧义，也不受剪枝影响。

**让各个 adapter 自己追加事件。** adapter 拥有预算，但不拥有会话表层；在循环之下追加表层事实绕过了循环对派生历史的所有权，也会让两个 adapter 对表层做出不同定义。adapter 改为上报它需要的数量。

**为内联回退和精确字节溢出保留临时的额外省略。** 恰好会在不变量所针对的场景发送未记录的投影；失败再推进的路径只多花一次序列化尝试，且让每个已发出请求都可由日志派生。

## 后果

预算变大、选中更大的路由或 compaction 降低总量时，被省略的图片不会自动回归；恢复手段是占位文本中的只读路径，模型需要时主动使用。一次 Files 故障或临时切到小预算路由会永久推进水位，两者出于同一理由被接受。

每个已发出请求的图片集合仅由日志决定，覆盖 file 模式、内联回退、resume、fork、retry 和 compaction，provider 缓存前缀不再抖动。占位和句柄文本中嵌入的执行世界访问路径仍在序列化时解析，这个缺口对保留的图片同样存在，属于另一个关于记录执行世界映射的决定。

## 测试

`packages/llm/llm/tests/content.spec.ts` 钉住图片遍历、位置排序、表示字节、标记、投影和水位规划器，包括 129 到 64 MiB 的量子示例。`packages/core/session/tests/image-offload.spec.ts` 钉住追加与 seed 校验、严格推进、嵌套标记、冻结副本、缓存重建和从头重放的一致性。`packages/core/agent-loop/tests/image-offload.spec.ts` 钉住发送前推进、不回退的水位、`IMAGE_OFFLOAD_REQUIRED` 的推进并重建路径以及耗尽的情况。adapter 测试钉住占位投影、只读取保留图片以及带数量的精确字节失败；`route-pricing.spec.ts` 钉住水位定价；replay adapter 测试钉住 `imageRequestMaxBytes`。`image-offload` ACP 快照通过发布的 profile、在一条 base64 预算只容纳三帧的 replay 路由下重放一段人工编写的六帧会话，钉住第一次 `request/header` 之后追加的 `image/offload` 水位和保持不变的第二轮。
