# Agent Note: 策略窗口与最大窗口的区分及压缩准入

Status: proposed

[English](2026-08-21-policy-versus-maximum-context-window-and-compaction-admission.md) | 中文

## 问题

一个长会话在 1,000,000 token 窗口的模型上增长到约 600k input tokens，随后在会话中途改路由到一个模型：其安装的 pi-ai catalog 条目解析出的 `contextWindow` 为 272000。同一部署本机的模型元数据同时携带两个不同事实：`context_window` 272000 与 `max_context_window` 872000。harness 的词汇表里每个模型只有一个容量，因此只有第一个事实对它存在。

改路由之后，每次自动压缩都失败。会话中的 270 个 `compaction/start` 事件里，有 266 个在 2026-08-20T20:48:40+08:00 到 2026-08-21T06:51:27+08:00 之间以完全相同的错误 `pi-ai detected context overflow for model "gpt-5.6-sol"` 结束；另有一次 close 报 `terminated`、一次 `fetch failed`；仅有的两次成功压缩都发生在改路由之前，运行在 1,000,000-token 模型上。经该 272000 窗口路由成功返回的最大请求携带 615,520 input tokens——provider 接受了远高于 catalog 数值的输入，而 harness 一直称之为溢出。

误判机制位于 `packages/llm/llm-pi-ai/src/stream.ts`：`mapStopReason` 把单一解析出的 `contextWindow` 传给 pi-ai 的 `isContextOverflow`，而该启发式——为静默截断输入的 provider 而写——把任何 `stopReason: 'stop'` 且 `usage.input + cacheRead > contextWindow` 的响应都判为溢出。压缩摘要器把会话前缀（system、tools、选中区域）加上压缩指令经同一路由重放，并以 `stop` 结束；输入超过 272000 后，每一次这样的成功响应都被重新归类为 `CONTEXT_WINDOW_EXCEEDED`，压缩事务因此永远无法闭合。主 tool-use 请求以 `toolUse` 结束，不经过该启发式检查，这正是会话本身仍在工作而压缩空转的原因。

重复是结构性的。`maxOverflowRetries` 只限制 `packages/compaction/compaction-basic/src/index.ts` 中 `agent/request-error` 恢复序列的预算，而主请求成功使这些请求错误从未触发。`agent/pre-step` 压力处理器对每次压缩失败只记录警告并继续轮次，于是同一个确定性失败在每个后续 tool step 之前重跑：270 个 start 中有 260 个落在同一个轮次内，中位间隔 85 秒。

还有两个缺口补全全貌。溢出恢复的区域选择以 `retainTokens=0` 调用 `selectCompactableRange`——选择最大的平衡旧区间——压力选择则保留同一窗口的一个比例，但二者都没有证明由此构成的摘要请求能装进摘要模型的输入预算；`packages/compaction/compaction-basic/src/summarizer.ts` 里复用前缀的设计使该请求至少与被压缩区域一样大。同时，由于单一 `contextWindow` 同时驱动主动压力阈值（`resolveCompactSpec`）与溢出判定，任何配置都无法表达「按 272000 做预算，此路由最高可承载 872000」。

## 提议

冻结以下 provider 中立、model 中立的行为。任何规则都不点名 provider、模型、agent 或具体数值窗口；每条规则都用解析出的容量与测量出的 token 表述。

### 两个容量、两个字段、一条权威链

`contextWindow` 保持为策略窗口：harness 据此做预算的容量——压力阈值、摘要准入预算、切换预检。`maxContextWindow` 是硬窗口：该路由可承载的最大输入，也是溢出判定唯一用来比较 usage 的容量。

每个字段经同一条权威链解析：显式部署配置（`models` 条目或 `modelOverrides` 字段）优先于路由本地能力元数据，优先于安装的 catalog 条目，优先于路由的 `defaultContextWindow`。只披露一个数字时它同时充当两个角色，因此每个只披露一个容量的模型保持今天的行为。任何代码路径都不得从策略值推断出更大的最大值。部署本地的能力文件只是该部署中该路由上一条 override 的证据；绝不将其提升为对其他部署生效的 catalog 事实。解析时校验正整数与 `maxContextWindow >= contextWindow`，并在加载时点名出错 key 地大声失败。

### 规范化的溢出判定

`CONTEXT_WINDOW_EXCEEDED` 恰好在两种情况下返回：provider 返回可识别的溢出错误；或已完成的响应证明 provider 截断了它——`stop` 且 `usage.input + cacheRead > maxContextWindow`，或 `length` 且零输出且输入填满硬窗口。硬窗口之内的成功响应绝不因超过策略窗口而被重新归类为溢出。

### 摘要准入预算

区域选择受摘要模型自身解析出的策略窗口约束，减去定价前缀——system、tools、压缩指令——再减去可配置的安全边际。当平衡旧区间超过该预算时，压缩以多次平衡、有界的 pass 进行：每个 pass 只摘要它所替换的区间并落自己的 checkpoint，pass 序列在声明的次数上限内收敛。压缩绝不摘要较小区间却替换更大的区间，绝不截断请求后仍替换完整区间，而是大声失败。每 pass 的 summary-smaller 校验、tool-call/result 配对平衡，以及 checkpoint 溯源（带 `shadowedRange`、`shadowedSeqs`、`shadowedTokenCount` 与 `sourceEventSeqs` 的 `compaction/summary`）保持不变。

### 确定性失败熔断

一次自动压缩失败若原因确定——在由 surface `replaceGeneration`、路由目标与生效策略组成的 key 不变时重复出现同一判定——则打开熔断：熔断期间，后续 step 不再发起任何新的摘要 provider 调用。generation、路由或策略变化时熔断清除，操作者通过手动压缩或会话维护干预时亦然。被熔断的会话在诊断中报告持有的原因；熔断绝不静默吞掉失败。

### 大切小切换预检

提交一次改路由之前，若其解析出的策略窗口小于会话投影的下一请求规模——测量出的 surface tokens 加上定价的 system prompt 与 tools——切换要么先压缩到新窗口下的安全边际，要么大声失败并保留旧模型。会话身份、日志连续性与 Kernel 语义不变：`agent-loop`、`SessionEventMap` 与持久化 `request/context` 载荷都不改（Kernel 变更 = NONE）；预检落在为下一个请求盖 provider 与 model 的路由表面上。

## 执行交接

**窗口执行。** 扩展模型容量词汇表（`LlmModelContext`、`packages/llm/llm-pi-ai/src/catalog.ts` 中的 catalog 与 profile 物化）以承载两个容量及其权威链；把 `packages/llm/llm-pi-ai/src/stream.ts` 及其在 `adapter.ts` 中调用点的溢出判定改指向硬窗口；交付 llm-pi-ai 测试、受影响文档与 changeset。

**压缩执行。** 为 `packages/compaction/compaction-basic` 增加摘要准入预算与有界平衡多 pass 区域选择；为自动压力路径增加确定性失败熔断；扩展 `compaction-loop-repro.spec.ts` 的回归覆盖。

**切换执行。** 在模型切换表面增加改路由预检：先压缩后提交，或大声失败并保留旧模型；不改会话身份与 Kernel 语义。

每个交接可独立落地；任何交接都不修改其点名表面之外的生产行为，本 note 也不实施任何一项。

## 考虑过的替代方案

**维持现状：把超过策略窗口的任何完成响应判为溢出。** 否决：只要策略与最大值不同，它就把成功的 provider 响应变成压缩失败，即本次事故本身。

**把 catalog 的 `contextWindow` 抬到部署最大值。** 否决：策略窗口才是压力与准入做预算的依据；抬高它会关闭真实最大值之下的主动压缩，把所有会话推到溢出恢复上。

**把部署本地的最大值发布为全局 catalog 事实。** 否决：本地能力缓存只证明其自身路由与部署的容量；同一模型的其他部署可能执行不同的最大值。

**从摘要调用中去掉复用前缀。** 否决：裸区间会丢掉工具上下文与 KV 缓存复用；用准入预算约束区间既保留前缀又能装下请求。

**为压力压缩加每 step 退避。** 否决：退避只是放慢燃烧并不设上界；状态不变下的确定性失败必须完全停止发起 provider 调用。

**压力压缩失败时终止轮次。** 否决：主请求是成功的；终止轮次会把一个能工作的会话变成事故。

## 验收标准

- 620,000-token 会话在 272,000 策略窗口、872,000 硬窗口下收到成功 provider 响应而不被判溢出，由 finish 映射上的 adapter 级测试钉住。
- 超过硬窗口的输入产生规范的 `CONTEXT_WINDOW_EXCEEDED` 失败，provider 错误文本与截断证明的 usage 启发式两条路径都要覆盖。
- 超过准入预算的摘要区间通过有界 pass 缩小替换范围或大声失败；被替换区间始终等于被摘要区间，任何被截断的请求都不替换完整区间。
- 在相同状态——surface generation、路由、策略——且摘要器确定性失败时，至少连续 20 个 tool step 发起的有界摘要 provider 调用数不随 step 线性增长，熔断后为零。
- 在 1,000,000-token 窗口模型上增长到约 600k tokens 的会话切换到 272,000 策略窗口模型时，要么在改路由提交前先压缩到安全边际，要么拒绝切换、保留旧模型并说明原因；session id 不变。
- tool-call/result 配对平衡、每 pass 的 summary-smaller 校验与 checkpoint 溯源在每条新路径上都保持；回归覆盖扩展 `compaction-loop-repro.spec.ts`；窗口执行附带 llm-pi-ai catalog 与 stream 测试及 changeset。

## 风险

**两个容量使误配置面翻倍。** 加载时校验与诊断必须点名出错 key 与被违反的关系（`maxContextWindow >= contextWindow`），让错误的数值对在解析时而非轮次中失败。

**准入预算可能把历史拆成很多 pass。** 声明的 pass 上限加上每 pass 的 summary-smaller 不变量让收敛可观察；到达上限就大声失败而不是循环。

**熔断可能掩盖瞬时原因。** 熔断 key 恰好包含确定性重试可能改变的输入——generation、路由、策略——被熔断的诊断会报告持有的原因，操作者能区分熔断与静默跳过。

**预检给的是估计值。** token 估计与 provider 计数有漂移；预压缩安全边际吸收漂移，估错也以规范溢出码在 provider 边界浮出，而不是变成错误路由的会话。

**声明的最大值可能高于真实限制。** 路由 override 以其部署的证据为限；provider 确认的溢出错误在任何声明的最大值之上仍是权威。
