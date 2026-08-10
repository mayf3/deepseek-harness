# Agent Note: 被取消的流定稿其已送达前缀

Status: implemented

[English](2026-08-10-cancelled-stream-prefix-finalize.md) | 中文

## Problem

轮次在流式输出中途被取消时，被打断的 step 已流出的内容过去会被整体丢弃：`assistant/chunk` 事件留在日志里供回放，但没有任何 `assistant/message` 进入 surface，`deriveMessages()` 不会把被打断的输出带进下一次请求。用户看着文字流出来，客户端在 abort 之后也继续显示它，但从模型的视角那段话从没说过。取消后追问「第二点展开讲讲」接不上，在被取消的轮次上 fork 出的分支继承的 surface 也缺少其主人读过的内容。这个分歧从来不是权衡后的决定：agent loop 的第一版实现就在分片循环里检查 abort 信号并在定稿 append 之前抛出，后来的 surface 白名单把这个形状固化了下来。

它违反的主导原则是：用户能看到什么，下一次模型请求就包含什么。

## Decision

`Agent.step()` 让当前流式尝试（assembler、已记录的分片 seq、提供方路由）在请求循环之间保持存活。当 abort 在尝试未提交时逃出 step，`appendInterruptedAssistant` 会在 abort 继续走向 `step/end`/`turn/end` 收尾之前，把该尝试的用户可见前缀定稿为该 step 的带 `interrupted: true` 的 `assistant/message`，`surfaceOp: 'append'`，`sourceEventSeqs` 恰好引用已记录的分片。这个持久标记就是消费者读取的分类：chat 投影继续把定稿前缀渲染为被打断（Stopped 徽章），请求检查让该请求保持未完成，由 step 边界照旧归类。以 `error`/`aborted` finish 结束的尝试会在恢复 waterfall 运行前被清空：提供方故障不提交任何内容，落在恢复期间的取消（典型是 `llm/retry` 退避期，此时客户端已重置流式渲染）不得复活失败流的前缀。

`BlockAssembler.interruptedBlocks()` 拥有「什么可以安全定稿」的规则，与既有的 max-tokens 截断规则放在一起：按流顺序保留内容非空白的已闭合与未闭合 `text`/`reasoning` 块。工具调用整块丢弃，因为打断先于分派，保留的调用会要求捏造一个结果；空块和未知类型的未闭合块同样丢弃。没有内容存活时不追加任何事件，轮次保持原有形状：分片、`step/end`、`turn/end` aborted。

工具执行期间的取消不受影响：带工具调用的消息此前已定稿，已启动的调用排空为真实结果，未分派的调用保留合成的 `ABORTED_BEFORE_DISPATCH` 对。提供方故障（终局 error 或 aborted finish）仍然不提交任何内容；只有轮次取消定稿前缀，因为只有在那里用户看到过将从模型历史中消失的内容。

## Alternatives considered

**继续丢弃前缀（维持现状）。** 安全且简单，但它让「取消然后转向」这个高频操作每次都制造一个用户可见与模型可见的分裂，fork 也继承这个缺口。否决：分裂的成本反复发生，定稿的成本只付一次。

**在请求时从已记录分片投影前缀。** 不加新 surface 事件，让 `deriveMessages()` 为 aborted step 装配分片前缀。否决：它把装配策略搬进每个 surface 消费者，破坏「三类产生消息的事件」的 surface 合同，并让派生历史依赖非 surface 事件。

**连完整的工具调用块也定稿，配合成的 aborted 结果。** 保留更多模型意图。否决：这些调用从未分派也从未渲染成工具卡片，对等原则并不要求它们，捏造的结果对还会增加模型可见的噪音；max-tokens 规则本来就丢弃不可分派的调用。

**追加显式打断标记（`[interrupted by user]` 用户消息）。** Claude Code 的做法，告诉模型回答是被切断的而不是完整的。搁置而非否决：它是叠加在本次对等修复之上的一个独立的模型可见词汇决定（source 种类、UI 渲染、locale 文案），而持久的 `turn/end aborted` 已经记录了这个事实，未来的投影可以使用。

## Consequences

surface 现在包含取消瞬间用户看到的内容，取消后的追问和 fork 都能接上。cancel 与 goal 两组快照 fixture 记录了定稿前缀事件，ACP 桥在 cancelled stop reason 之后把它作为最后一条 `agent_message_chunk` 更新转发，prompt 的结算不等待循环收尾，因此自动化客户端可能在 cancelled stop reason 之后才收到该更新。被打断 step 的 `assistant/message` 带着中途截断的前缀和用于归类的 `interrupted: true` 标记。终局提供方错误保持旧行为，其已流出前缀仍会从 surface 消失，这个不对称是有意留给后续决定的，因为 error 轮次的结束不是用户主动选择的停止。

## Testing

`packages/core/agent-loop/tests/cancel.spec.ts` 固定了流中取消的定稿（内容、引用的 seq、事件顺序、下一请求的对等）、仅 reasoning 的定稿、半流式工具调用的丢弃和无可定稿内容的情形。`packages/llm/llm/tests/assembler.spec.ts` 固定了 `interruptedBlocks()`。keyless 的 `cancel` ACP 快照和 goal-session 快照承载装配后应用的 transcript。
