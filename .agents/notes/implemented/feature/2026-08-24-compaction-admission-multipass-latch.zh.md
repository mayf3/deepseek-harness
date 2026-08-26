# Agent Note: 组合上下文准入、有界多趟压缩与确定性压缩闩锁

Status: implemented

[English](2026-08-24-compaction-admission-multipass-latch.md) | 中文

在 `packages/compaction/compaction-basic` 中实现治理提案 [Policy versus maximum context windows and compaction admission](../../proposed/bug-fix/2026-08-21-policy-versus-maximum-context-window-and-compaction-admission.md) 的 COMPACTION 交接。

## Problem

自动压缩在发出摘要调用前，无法证明该摘要请求本身能装进摘要模型的组合上下文：既没有为回放前缀加指令计预算，也没有为实际输出预留容量；而确定性失败会在后续每个工具步骤前重跑（一次会话中观测到 266 次完全相同的被分类为溢出的压缩尝试）。

## Decision

**准入证明完整请求。** 每次摘要调用必须满足 `pricedSystem + pricedTools + pricedSelectedMessages + pricedInstruction + effectiveOutputReserve + tokenizerSafetyMargin <= effectiveContextBudget`。计价使用适配器实际发送的表示：envelope 部分经 `TokenMeter.estimateEnvelopeParts`（现有纯 envelope 估算器的新的实例门面，与 `estimateMessage` 对称）；选中消息经 token meter 自己的逐节点表层价格；指令经对 `summarizeWithLlm` 实际追加消息的计价（`compactionInstructionMessage()`）。输出预留是解析后的 `maxTokens` —— 包括继承的 8192 默认值 —— 绝不假设为零。`tokenizerSafetyMargin` 是经过校验的配置字段（默认 0），并进入闩锁 key。

**容量经单一接缝解析。** `capacity.ts` 按操作为精确摘要目标解析一次预算（显式对 → 最新路由目标 → agent 回退，提取为 `resolveSummarizationTarget`，使准入、闩锁 key 与默认摘要器共享同一解析）。今天该预算是 `resolveModelInfo()` 返回的路由唯一 `contextWindow`；不推断百分比、上限或提供方元数据。该模块是 WINDOW 交接将其改指向适配器拥有的容量快照的唯一位置。

**准入失败 fail loud 且绝不截断。** 无法准入的请求 span 抛出分类的 `admission-impossible` 错误；`compactRegion` 绝不缩小或截断调用方选择的 span 来伪装准入通过。

**最大平衡区域装不下时进行多趟。** 趟选择取已计价消息能装入准入余量的最大平衡头部前缀，绝不切断工具调用／结果配对（`selectAdmittedCompactionRange`）。每趟只摘要它真正替换的 span 并落下自己的检查点与完整溯源；每趟必须严格降低计量表层 token（否则 `no-progress`）；趟上限为 `compactionRetries + 1`，到达上限即 fail loud（`pass-bound-exceeded`）。终止性成立：每个成功趟严格缩减有限表层，可压缩头部耗尽即为无操作。

**确定性闩锁约束提供方调用。** 闩锁 key 覆盖 `replaceGeneration`、会话目标与摘要目标、容量身份、输出预留、安全余量、趟策略（`maxPasses`、有效 `retainTokens`）与 `PASS_POLICY_REVISION`，外加失败分类。确定性类别：`admission-impossible`、`no-balanced-eligible-span`、`pass-bound-exceeded`、`no-progress`、`summary-not-smaller`、提供方已确认的 `CONTEXT_WINDOW_EXCEEDED`、请求尺寸类 `INVALID_REQUEST` 措辞。首次失败记录，允许一次确认 —— 同一未变化 key 下至多两次摘要调用以确定性失败结束 —— 之后闩锁保持，自动调用为零，同时每次压力检查报告 held 原因。普通 assistant／tool／user 追加绝不清除它；持久替换使 `replaceGeneration` 前进并使其失效；手动 `compactNow` 执行恰好一次显式探针而不先删除 held key，复现时立即重新闩锁。`TRANSPORT`、`SERVER`、`TIMEOUT`、`ABORTED`、限速／配额、`terminated`、`fetch failed`、不完整流与未分类失败都是瞬时的，绝不闩锁。闩锁按会话保存在内存中；现有 `maxOverflowRetries` 预算继续授权有持久进展证明的请求级重试，held 闩锁则无视该预算抑制新的摘要调用。

## Alternatives considered

**压力尝试之间退避。** 治理提案已否决：退避只是减慢消耗而不设界；未变化的确定性 key 必须完全停止发出提供方调用。

**对提供方已确认的溢出恢复跳过准入。** 否决：无论触发原因如何，摘要请求都必须被证明；摘要路由缺少已披露容量时，操作点名该路由并 fail loud。

**在 compaction-basic 复制固定密度估算器。** 否决：估算器属于 token meter；准入经同一纯函数的新的实例门面为 envelope 计价，使所有数字保持在同一词汇下。

**首次确定性失败即闩锁。** 否决：一次确认探针把可复现类别与偶发提供方判定区分开，同时仍把调用约束在两次以内。

## Consequences

路由缺少已披露容量、或 span 无法容纳时，`compactRegion` 现在 fail loud，而此前会直接发出请求；因此溢出恢复要求摘要路由披露容量（会话路由缺少容量时，带容量的显式摘要对仍能保持恢复工作）。现有测试的 fixture 窗口被重新平衡，因为继承的 8192 预留合理地超出小测试窗口。`summary-not-smaller` 与趟上限耗尽现在是分类的确定性错误，消息文本与之前一致。完整 SWITCH 预检落地时可直接消费 `resolveCapacitySnapshot` 与同一准入核心。
