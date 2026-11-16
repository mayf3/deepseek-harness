# Agent Note: 将网关重试缓冲区超限归类为 INVALID_REQUEST

Status: implemented

[English](2026-10-09-pi-ai-retry-buffer-limit-classification.md) | 中文

## Problem

网关边缘在向上游重试一次失败的请求时，必须缓冲原始请求以便重发。当被缓冲的请求超过边缘的缓冲区上限时，边缘会以 `exceeded request buffer limit while retrying upstream` 使该次交换失败——这是直接拒绝措辞 `failed to buffer the request body: length limit exceeded`（适配器自 request-image-payload-bound 修复起已归类为 `INVALID_REQUEST`）的重试阶段兄弟措辞。Envoy 参考路由只在无活跃上游尝试时（早前上游失败后的重试退避期）发出该 507；有活跃上游请求时则放弃缓冲、不发出此文本，改走普通上游失败处理——因此该措辞总是带有边缘的重试阶段上下文。pi-ai 在终态事件之前就把捕获到的供应商错误扁平化为 `error.message`，丢弃 HTTP 状态码，因此 `classifyPiAiError` 没有命中任何规则——没有状态码数字，措辞也与已归类的兄弟措辞不同——失败以兜底类 `PI_AI_ERROR` 呈现。同一个请求缓冲区家族仅因措辞不同就被路由成两个代码。生产中已在一条 Feishu 通道 agent 的模型路由上观察到：交付的通知文本为 `PI_AI_ERROR: exceeded request buffer limit while retrying upstream`。

## Decision

`classifyPiAiError` 在既有 `INVALID_REQUEST` 规则中扩展重试阶段措辞。两种措辞描述同一网关请求缓冲区家族，因此都路由为 `INVALID_REQUEST`——这是该家族的保守非重试选择。这是路由决策而非确定性声明：超限说明请求在重试缓冲时超过边缘缓冲区，不证明请求永久无效；稍后重发相同请求是否成功取决于上游状态与边缘缓冲余量。它不被重试，是因为既有受支持的本地规则同样不重试兜底类，且对结果历史未证实的请求自动重放本就被禁止。所有类的恢复语义均不变：`INVALID_REQUEST` 仍在默认可重试集（`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`）之外、仍在禁止 fallback 集之内，因此本次重新归类只改变路由代码，不启用任何重试、供应商 fallback 或 turn 重放。

## Alternatives considered

- **把该措辞映射为 `TRANSPORT` 或 `SERVER`，让组合的 retry policy 可以重试。** 拒绝：该文本证明的是边缘触及重试缓冲上限，而非纯线路瞬态故障；仅凭这一信号无法把原始请求的自动重放做到副作用安全；兜底类也不可变为可重试（这正是 transport-truncation 修复选择只归类特定可恢复措辞的原因）。该家族未来的有界恢复设计需要自己的证据（捕获的状态码、请求字节数、结果历史）。
- **在本修复中限制或裁剪组装后的请求。** 拒绝：该生产实例的错误是否确由请求大小驱动尚未证实——HTTP 状态与请求字节数从未被捕获，只有扁平化文本。超出既有 image-payload bound 之外的请求大小压缩是需要独立证据的单独设计工作。
- **等待 pi-ai 转发 HTTP 状态码或原始错误 cause。** 这是持久修复，分类器上已标注 `XXX(pi-ai upstream)`；在 pi-ai 暴露状态码或捕获钩子之前，分类只能是基于文本的尽力匹配。

## Consequences

- 重试阶段缓冲措辞现在与其直接拒绝兄弟措辞一起路由为 `INVALID_REQUEST`；按请求大小类失败过滤的运维方对该家族只看到同一个代码。
- 路由代码是保守的家族归类，不是永久无效的证明：该家族未来的有界恢复设计不得把此处的 `INVALID_REQUEST` 当作"相同重发必然失败"的证据。
- 分类仍依赖字符串匹配与具体措辞：网关或 pi-ai 未来改写该消息后会静默回落到 `PI_AI_ERROR`，直到模式列表更新。
- 任何错误类的恢复行为都不变；重新归类只在路由代码与下游过滤器中可观察。
