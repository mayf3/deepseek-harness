# Agent Note: 策略窗口与最大窗口的区分及压缩准入

Status: proposed

[English](2026-08-21-policy-versus-maximum-context-window-and-compaction-admission.md) | 中文

## 问题

一个长会话在 1,000,000 token 窗口的模型上增长到约 600k input tokens，随后在会话中途改路由到一个模型：其安装的 pi-ai catalog 条目解析出的 `contextWindow` 为 272000。同一部署本机的模型元数据同时携带两个不同事实：`context_window` 272000 与 `max_context_window` 872000。harness 的词汇里每个模型只有一个容量，因此只有第一个事实对它存在。

改路由之后，每次自动压缩都失败。会话中的 270 个 `compaction/start` 事件里，有 266 个在 2026-08-20T20:48:40+08:00 到 2026-08-21T06:51:27+08:00 之间以完全相同的错误 `pi-ai detected context overflow for model "gpt-5.6-sol"` 结束；另有一次 close 报 `terminated`、一次 `fetch failed`；仅有的两次成功压缩都发生在改路由之前，运行在 1,000,000-token 模型上。经该 272000 窗口路由成功返回的最大请求携带 615,520 input tokens——提供方接受了远高于 catalog 数值的输入，而 harness 一直称之为溢出。

误判机制位于 `packages/llm/llm-pi-ai/src/stream.ts`：`mapStopReason` 把单一解析出的 `contextWindow` 传给 pi-ai 的 `isContextOverflow`，而该启发式——为静默截断输入的提供方而写——把任何 `stopReason: 'stop'` 且 `usage.input + cacheRead > contextWindow` 的响应都判为溢出。压缩摘要器把会话前缀（system、tools、选中区域）加上压缩指令经同一路由重放，并以 `stop` 结束；输入超过 272000 后，每一次这样的成功响应都被重新归类为 `CONTEXT_WINDOW_EXCEEDED`，压缩事务因此永远无法闭合。主工具调用请求以 `toolUse` 结束，不经过该启发式检查，这正是会话本身仍在工作而压缩空转的原因。

重复是结构性的。`maxOverflowRetries` 只限制 `packages/compaction/compaction-basic/src/index.ts` 中 `agent/request-error` 恢复序列的预算，而主请求成功使这些请求错误从未触发。`agent/pre-step` 压力处理器对每次压缩失败只记录警告并继续轮次，于是同一个确定性失败在每个后续工具步骤之前重跑：270 个 start 中有 260 个落在同一个轮次内，中位间隔 85 秒。

还有三个缺口补全全貌。溢出恢复的区域选择以 `retainTokens=0` 调用 `selectCompactableRange`——选择最大的平衡旧区间——压力选择则保留同一窗口的一个比例，但二者都没有证明由此构成的摘要请求加输出预留能装进摘要模型的请求与响应合并上下文。单一 `contextWindow` 同时驱动主动压力阈值与溢出判定。观测到的 `openai-codex` 路由由外部 `dsh-codex` 所有；它从 `openaiCodexProvider()` 直接构造 `PiAiAdapter`，不经过普通 llm-pi-ai settings catalog，因此仅修改 catalog 物化无法向该路由交付其本地容量。

## 提议

冻结以下提供方无关、模型无关的行为。Core 代码不点名任何提供方或模型，也不读取 Codex 专用文件；适配器通过通用 LLM 词汇解析路由本地事实。

### 合并容量与权威来源

`contextWindow` 是生效合并上下文：该路由当前实际运行的请求与响应合并上下文最大值，也是驱动压力、压缩准入与切换预检的容量。`maxContextWindow` 是 override ceiling（覆盖上限）：显式配置覆盖允许把生效上下文提升到的最大合并上下文。仅有 ceiling 绝不改变生效上下文，绝不声明 provider 硬限制，也绝不充当溢出判定权威。两个字段都表示请求与响应合并上下文，绝不表示仅输入容量。只披露一个数值时由它充当生效上下文，任何代码路径都不得在没有显式覆盖的情况下从 ceiling 推断生效上下文。

每个字段通过一条由适配器所有的权威链解析：显式部署配置优先于路由本地能力元数据，优先于安装的 catalog 条目，优先于路由 fallback。普通 llm-pi-ai settings 路由可以通过 `models` 或 `modelOverrides` 提供两个容量；包括外部适配器在内的任何适配器也可以改由 `resolveModel` 直接返回它们。通用字段名与校验属于 `@deepseek-ai/dsh-llm`；Core 绝不读取 Codex 能力文件，也绝不按提供方或模型名称分支。

解析时校验正整数，且两者都披露时要求 `contextWindow <= maxContextWindow`；生效上下文高于其 override ceiling 的配置在加载时点名出错 key 地失败。解析出的合并上下文为 `resolvedContextWindow = contextWindow ?? maxContextWindow`：披露生效上下文时取它，仅在生效上下文缺失时回退到 ceiling。路由还可以披露大于 0 且不超过 100 的百分比 `effectiveContextWindowPercent`；省略表示 100%。百分比作用于 resolved context，绝不作用于 ceiling：`effectiveContextBudget = floor(resolvedContextWindow * effectiveContextWindowPercent / 100)`。对观测元数据——生效上下文 272000、ceiling 872000、95%——resolved context 为 272000、有效预算为 258400；只有显式、合法地把生效上下文覆盖到 ceiling 后才会得到 828400。

适配器返回一个不可变容量快照，其中包含 `resolvedContextWindow`、可选的 override ceiling、生效百分比、`effectiveContextBudget`、静默溢出能力，以及每个字段的元数据来源与权威。一次操作的准入、熔断、诊断和切换预检使用同一快照。如果某条路由确需把 provider 确认的硬限制作为独立事实，适配器必须在单独证明的字段中声明它；绝不从 override ceiling 推断。部署本地能力文件只证明该部署中自身路由的事实，绝不提升为全局 catalog 事实。

### 成功响应的权威性

可识别的提供方溢出错误仍是最终权威，不受本地元数据影响，映射到规范的 `CONTEXT_WINDOW_EXCEEDED`。携带非空 assistant 内容的完整响应保持成功，即使上报的输入用量超过任何本地披露的容量；本地元数据不得把提供方成功改写成失败。适配器改为记录 capacity-metadata-drift 诊断，其中包含路由、容量快照与上报用量。

静默溢出检测是由所属适配器针对精确提供方协议解析的显式启用路由能力。能力缺失时禁用，不能仅因路由使用 pi-ai 就运行。冻结的异常签名要求每个已声明要素同时满足：终止原因由该能力明确允许、没有 assistant 内容块、上报输出 token 为零，且 `usage.input + cacheRead >= resolvedContextWindow`。仅比较用量并不充分。只有已启用能力且匹配完整签名的路由才可把响应映射为规范溢出；不匹配的空响应仍采用普通空响应或最大输出结果。

### 合并上下文准入

每次准入判断都要证明 `pricedSystem + pricedTools + pricedSelectedMessages + pricedInstruction + effectiveOutputReserve + tokenizerSafetyMargin <= effectiveContextBudget`。定价使用所选适配器将实际发送的精确摘要请求或普通请求表示。不能仅因尚无输出就把输出预留设为零。

生效百分比是一次性总预算折减，先于全部 harness 算术作用于 resolved context。harness 不声称知道该百分比覆盖了哪些上游预留，绝不把它说成已包含 system、tools、指令或输出，因此在它之后扣除每个精确定价组成部分与显式 tokenizer 安全边际。可能的重叠只是 harness 有意放弃的保守余量；harness 自身绝不重复扣除任何组成部分。

对压缩而言，`effectiveOutputReserve` 是精确目标策略解析后实际传给摘要调用的 `maxTokens`；因此当前继承默认值 8192 必须预留 8192 token。对普通请求与切换预检而言，它先取显式请求 `maxTokens`，否则取预备调用解析所物化的适配器自有 `defaultMaxTokens`。若两者都不存在，容量敏感的预检大声失败，而非假设为零。`tokenizerSafetyMargin` 是经过解析与校验的策略值，并被捕获进容量快照 key。

当最大的平衡旧区间超过准入预算时，压缩以多次平衡、有界的 pass 进行。每个 pass 只摘要它所替换的区间并落自己的检查点。压缩绝不摘要较小区间却替换更大的区间，绝不截断请求后仍替换完整区间；如果没有平衡 pass 能满足公式或达到声明的 pass 上限，则大声失败。每 pass 的 summary-smaller 校验、工具调用/结果配对平衡，以及检查点溯源（带 `shadowedRange`、`shadowedSeqs`、`shadowedTokenCount` 与 `sourceEventSeqs` 的 `compaction/summary`）保持强制。

### 确定性失败熔断

熔断 key 至少包含 `replaceGeneration`、会话提供方/模型目标、实际摘要提供方/模型目标、完整的已解析容量快照、生效输出预留、tokenizer 安全边际、pass 策略及其 revision，以及失败分类。普通 assistant/message 与 tool/result 追加不清除熔断。

确定性分类包括本地可复现的准入不可满足、没有合格的平衡区间、达到 pass 上限或无进展、summary-not-smaller 不变量失败、提供方确认的 `CONTEXT_WINDOW_EXCEEDED`，以及相同已准入请求的请求体大小 `INVALID_REQUEST`。`TRANSPORT`、`SERVER`、`TIMEOUT`、`ABORTED`、限流或配额失败、`terminated`、`fetch failed` 与不完整流属于瞬时失败，绝不打开永久确定性熔断。其他未分类的提供方失败保持瞬时，除非本提议以后加入可复现规则。

对一个不变的确定性 key，自动压缩最多可以发起两次提供方调用：第一次失败，以及最多一次确认 probe。随后进入熔断；该 key 下所有自动压力检查发起零次摘要提供方调用，同时继续报告所持原因。至少连续 20 个普通工具步骤及其普通消息与结果追加不得增加调用数。

手动压缩只授予一次显式 probe，不删除所持 key。成功会改变 generation 并清除已经失效的熔断；若同一确定性分类复现，则立即重新熔断。唯一能清除熔断的维护动作，是显式更新容量、目标、输出预留、安全边际或 pass 策略，且重新计算出的 key 确实不同；泛化的会话维护不是清除条件。

### 大切小切换顺序

可能降低准入容量的模型切换作为一个保留操作执行：`PREPARE → acquire idle/maintenance reservation → measure → compact with the previous route or an explicit summarization target → remeasure → COMMIT`。reservation 排除并发的下一个轮次，并一直持有到提交或回滚。两次测量都计入定价后的 system、tools、选中消息、适用时的指令、输出预留与安全边际。

如果重新测量仍不满足目标路由的准入公式，操作就大声失败、释放 reservation、保留旧模型选择、不产生任何目标部分提交，并保持 session id 不变。除非操作者把未提交的小路由另行显式选为摘要目标，否则压缩绝不经它运行。

整个保留操作期间会话身份、日志连续性与 Kernel 语义不变：`agent-loop`、`SessionEventMap` 与持久化 `request/context` 载荷都不改（Kernel 变更 = NONE）；该顺序落在为下一个请求盖 provider 与 model 的路由表面上。

WINDOW 与 COMPACTION 是完整 precompact-before-commit SWITCH 交付的先决条件。在两者都成立前落地的 SWITCH 变更只能实现 `REFUSE_ONLY`：使用已有的保守容量测量，并拒绝不安全切换，不尝试预压缩。它不得声称完整 precompact-before-commit 已可独立使用。

## 执行交接

**窗口执行。** 用生效上下文、override ceiling 与有效预算的容量快照以及显式启用的静默溢出能力扩展 `LlmModelContext` 和精确模型解析。扩展 llm-pi-ai `models` 与 `modelOverrides`，但保持容量解析由适配器所有，使外部适配器能通过 `resolveModel` 提供相同字段。把流分类改为提供方错误权威、metadata-drift 记录及能力约束的强签名。交付适配器、catalog、stream、文档与 changeset 覆盖。

经核证的外部集成基线是 `Yan-Zero/dsh-codex` 的 `dsh-codex@0.2.4`——已安装、其 `createOpenAICodexAdapter()` 拥有观测路由的适配器。在协调的 dsh-codex 变更让 `createOpenAICodexAdapter()` 把路由的生效 `context_window`、override ceiling `max_context_window` 与 `effective_context_window_percent` 翻译进通用快照——`resolvedContextWindow`、override ceiling、`effectiveContextBudget`——并携带每个字段的来源之前，WINDOW 均不完整；只有协议证据证明冻结的签名时，它才能把静默溢出能力解析为启用，否则必须保持缺失或禁用。该变更还要增加适配器集成测试，并发布精确 dsh-codex 包版本与源 revision、精确 pin 到包含该词汇的 Harness 包 release，同时在该变更中记录基线自身的源 revision。版本范围或未记录的本地文件不能作为有效交接。

**压缩执行。** 为 `packages/compaction/compaction-basic` 增加合并上下文准入公式、实际输出预留、tokenizer 安全边际、有界平衡多 pass 选择与精确确定性熔断；扩展 `compaction-loop-repro.spec.ts`，覆盖精确调用上限与瞬时分类体系。

**切换执行。** 如有需要，先落地 `REFUSE_ONLY`。完整交付依赖 WINDOW 与 COMPACTION，随后在模型切换表面增加 reservation、旧路由或显式目标压缩、重新测量与原子提交，不改会话身份或 Kernel 语义。

本 note 不实现任何交接。WINDOW 与 COMPACTION 可以独立落地；完整 SWITCH 不能脱离它们独立落地。

## 考虑过的替代方案

**把超过本地元数据的任何完整响应判为溢出。** 否决：完整非空提供方响应是比陈旧本地容量元数据更强的证据；应记录漂移而非制造失败。

**为所有 pi-ai 路由启用静默溢出启发式。** 否决：pi-ai 是传输家族，不是每个提供方协议都会静默截断的证据。必须有精确路由能力并匹配完整空输出异常。

**把 override ceiling 当作 provider 硬限制或溢出权威。** 否决：ceiling 只约束配置覆盖；provider 硬限制与溢出判定权威是需单独证明的事实，静默溢出签名比较的是 resolved context。

**把生效百分比应用到 override ceiling 上。** 否决：百分比作用于生效与解析后的上下文——272000 的 95% 是 258400——把它应用到 872000 等于按一条未被显式覆盖、路由并未运行的窗口做预算。

**把 catalog 的 `contextWindow` 抬到部署最大值。** 否决：策略窗口才是压力与准入做预算的依据；抬高它会关闭真实最大值之下的主动压缩，把所有会话推到溢出恢复上。

**在 Core 中读取 Codex 元数据或增加 Codex 模型特判。** 否决：所属适配器已经控制精确路由解析。提供方无关的适配器结果既支持外部路由，也不会让 Core 耦合其文件。

**为压力压缩加每步骤退避。** 否决：退避只是放慢消耗并不设上界；状态不变下的确定性失败必须完全停止发起提供方调用，而瞬时失败仍按既有策略重试。

**预压缩前先提交较小路由。** 否决：它可能把压缩困在无法接纳现有历史的路由上，并在失败时暴露部分选择。

## 验收标准

- 用量超过本地 `maxContextWindow` 的完整非空响应保持成功并发出 capacity-metadata drift；通用用量比较不得把它改写成溢出。
- 没有精确静默溢出能力的路由绝不运行启发式。已启用能力的路由只有在完整的终止原因、空内容、零输出和用量签名同时匹配时才映射规范溢出。可识别的提供方溢出错误仍为权威。
- 模型容量以请求与响应合并上下文记录并测试。压缩准入计入实际摘要 `maxTokens`，包括继承的 8192 默认值；普通请求与切换预检计入物化后的请求输出预留和 tokenizer 安全边际。
- 测试钉住 `resolvedContextWindow = contextWindow ?? maxContextWindow` 与 `effectiveContextBudget = floor(resolvedContextWindow * effectiveContextWindowPercent / 100)`：生效上下文 272000、override ceiling 872000、95% 时解析为 272000、预算 258400；只有显式、合法地把生效上下文覆盖到 ceiling 才得到 828400。
- 生效上下文高于其 override ceiling 的配置在解析时点名出错 key 地失败；仅有 ceiling 绝不改变生效上下文，绝不声明 provider 硬限制，也绝不判定溢出。
- 协调后的精确 package/revision 上的 dsh-codex 适配器集成测试证明 `openai-codex` 通过 `resolveModel` 提供路由本地容量；Core 不读取 Codex 文件，也不包含提供方/模型特判。
- 在一个不变的确定性熔断 key 下，`CALLS_BEFORE_LATCH <= 2` 且 `CALLS_WHILE_LATCHED = 0`；至少连续 20 个普通工具步骤不增加调用。瞬时 `TRANSPORT`、`SERVER`、`TIMEOUT`、`terminated` 与 `fetch failed` 不永久熔断，失败的手动 probe 立即重新熔断。
- 切换测试证明 reservation 排除并发轮次、摘要使用旧路由或显式摘要目标、重新测量先于提交，且失败保留旧选择、不留下目标部分状态并保持同一 session id；两次预检测量与压缩准入消费同一个不可变容量快照。
- 交接测试与文档明确完整 SWITCH 依赖 WINDOW 与 COMPACTION；任何更早的 SWITCH 交付都命名为 `REFUSE_ONLY`，且不声称支持 precompact-before-commit。
- 工具调用/结果配对平衡、每 pass 的 summary-smaller 校验、检查点溯源与大声失败行为在每条压缩路径上都保持；三个交接携带其聚焦测试、受影响文档、changeset 与集成 pin。

## 风险

**容量元数据可能向任一方向陈旧。** 提供方确认的溢出仍为权威，完整非空成功产生漂移而非失败，生效百分比与安全边际则保护准入，同时不假装元数据就是提供方真相。

**准入预算可能把历史拆成很多 pass。** 声明的 pass 上限加上每 pass 的 summary-smaller 不变量让收敛可观察；到达上限就大声失败而不是循环。

**熔断可能掩盖可恢复原因。** 只有冻结的确定性分类才能熔断，瞬时分类不能。精确 key、手动单 probe 行为与所持原因诊断会显露何种有意义状态变化允许再次尝试。

**跨仓库交付可能漂移。** 经核证的 dsh-codex 基线与要求的最终精确 package/revision pin，使外部适配器变更成为 WINDOW 验收的一部分，而不是假设中的后续事项。

**切换 reservation 可能延迟轮次。** reservation 仅覆盖 prepare、测量、可选压缩、重新测量，以及提交或回滚；它换来原子选择与稳定测量。
