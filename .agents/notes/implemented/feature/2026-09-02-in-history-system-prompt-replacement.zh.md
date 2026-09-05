# Agent Note: 历史内系统提示词替换，实现缓存稳定的提示词变更

Status: implemented

[English](2026-09-02-in-history-system-prompt-replacement.md) | 中文

## Problem

每一次系统提示词变更都要付出整个提供方前缀缓存的代价。循环在每个步骤渲染提示词；一旦字节不同——plan 模式片段进入或退出、某个 skill 或工具指引片段完成注册、agent 作用域的 persona 遮蔽、`{{model}}` 变量改变——请求的消息 0 随之改变，DeepSeek 上下文缓存从第一个 token 起失效。长时间的 agent 会话反复为此付费，而[运行时上下文快照设计](../../archived/feature/2026-07-30-current-sandbox-policy-context.md)之所以存在，正是因为把会变化的事实移出提示词是保持前缀稳定的唯一办法。

一个 DeepSeek 模型——在此按为本项工作提供的模型事实记录——移除了这一限制：它接受对话任意位置的 `system` 消息，并把最新一条视为完整的有效系统提示词，替换最前面那条。工具 schema 仍属于被缓存的前缀，因此工具集变更仍会使缓存失效。有了这样的模型，harness 可以把新提示词追加到已缓存的历史之后而不是重写消息 0，前缀就能保持热态。

因为[系统提示词是 surface 第 0 号节点](../architecture/2026-09-02-system-prompt-as-surface-node.zh.md)，harness 拥有实现这一点的表示：提示词变更是对 `system/message` surface 节点的操作，而「替换最新的系统节点」与「追加新节点」之间的选择是逐路由的决定。

## Decision

对于声明了该能力的模型路由，当渲染后的提示词变化且前缀本可存活时，循环追加一个新的 `system/message` surface 节点而不是替换最新的系统节点。[surface 节点决策](../architecture/2026-09-02-system-prompt-as-surface-node.zh.md)中的其他一切不变：事件类型、投影的拥有者、序列化器，以及第 0 号节点的头部保护。

### 能力

`dsh-llm` 定义 `SystemPromptUpdate = 'in-history'`，并把它作为可选的并列字段 `systemPromptUpdate` 放在 `LlmResolvedModelInfo` 与 `PreparedLlmCall` 上；`normalizeModelInfo` 用代码为 `INVALID_MODEL_INFO` 的 `LlmError` 拒绝任何其他值。DeepSeek 适配器的目录模型（`DeepSeekCatalogModel.systemPromptUpdate`，加载时由 zod 校验）与回放提供者的 `ReplayModelConfig.systemPromptUpdate` 逐模型声明它；缺省表示该模型需要重写消息 0。没有默认目录条目声明它；部署方通过 `cordis.yml` 的 `models` 列表启用，所有 `dsh-llm-pi-ai` 路由保持替换行为。

循环把该模式记录进会话：`RequestContext.systemPromptUpdate` 与 provider、model、容量并列成为 `request/context` 的字段，其中任一项与最新快照不同时就记录一次。决策读取 `session.requestContext()?.systemPromptUpdate`，因此恢复后的循环实例沿用它上次请求所用路由的模式，路由变更从记录之后的第一个请求起生效。

### 决策规则

`packages/core/agent-loop/src/runtime-context.ts` 中的 `SystemPromptProjection.project(rendered, { inHistory, startsSeries })` 每次调用都扫描当前 surface 上存活的 `system/message` 节点。没有存活的系统节点时，渲染后的提示词非空即追加；最新系统节点已持有渲染文本时不产生任何事件。其余情况：

| 路由能力 | 前缀状态 | 操作 |
|---|---|---|
| 无 | 任意 | 替换最新存活的系统节点（没有更后节点时即第 0 号节点） |
| `in-history` | 当前请求序列延续 | 在该步骤的 `user/message` 事件之前追加新的 `system/message`；不记录 `request/header` |
| `in-history` | 新序列开始且第 0 号节点是唯一存活的系统节点 | 用当前提示词替换第 0 号节点 |
| `in-history` | 新序列开始且有更后的系统节点存活 | 追加新的 `system/message`；第 0 号节点保持原样 |
| `in-history` | 渲染后的提示词为空 | 用空内容替换最新存活的系统节点，该节点投影为无消息 |

`startsSeries` 在以下情况为真：`agent/pre-step` 决定声明了 `startsRequestSeries`、surface 的替换代数自上次请求以来发生了移动（压缩或任何其他替换）、可见工具 schema 集合发生了变化。仅 provider 或 model 切换对本规则不算序列开始：变更后的提示词被追加，这不花任何代价，因为路由变更本身已经使缓存未命中。第三行存在，是因为序列开始已经付出了缓存代价；把提示词折回第 0 号节点能让历史保持简短。第四行存在，是因为 surface 没有删除操作：在更后的系统节点仍存活时替换第 0 号节点，会让模型把更后、已过时的节点当作权威。历史内模式在任何更后的系统节点存活期间永不重写第 0 号节点。

`packages/core/agent-loop/src/agent.ts` 中的 `preStep` 在 `agent/pre-step` waterfall 之后投影提示词，因此在该 waterfall 内运行的压缩（`auto: true` 的 `compaction-basic`）对决策可见：当它遮蔽了所有更后的系统节点时，第 0 号节点成为唯一存活者，变更后的提示词替换它。恢复属于序列延续——`resume` header 不是序列开始——因此跨重启发生变化的提示词被追加；提供方缓存在进程边界之后可能仍是热的。

### 呈现与记账

Web 在追加的历史内节点自己的位置呈现它。`SystemPromptNode` 携带 `{ seq, time, turn, step, text, update }`，其中 `update` 对已加载窗口内跟在更早系统节点之后的追加 `system/message` 为真。Chat 把非空的更新渲染为一张折叠的 `system-prompt` 卡片，标题取自 locale 键 `message.systemPromptUpdate`，同一 turn 与 step 内的 `request/header` 不会重复提示词卡片；`inspectRequestPrompt` 对跟在更新之后的 header 不报告系统变更。Trajectory 把跟在已加载请求 header 之后的更新折叠为一条合成的请求 header 事实，`promptChange.kind = 'system'`，因此之后的请求无需真实的 header 变更就能显示有效提示词。已加载窗口缺少更早的系统节点时，更新按初始提示词呈现。转录投影像对待所有 `system/message` 一样跳过它。

`dsh-token-meter` 像对待任何 surface 节点一样为追加的节点计价。它的 `contextBreakdown` 把最新的系统节点报告为系统数字，并在追加时把被取代提示词的 token 移入消息数字，因此遮蔽某个已被取代提示词版本的压缩认领恰好减去追加所增加的量；`dsh-token-meter` README 记录了唯一的漂移情形——压缩遮蔽了最新的历史内节点——循环在下一步骤通过替换第 0 号节点修复它。随后 `assistant/message` 用量上的 `cacheReadTokens` 是可观察的效果：对具备能力的路由，该值覆盖到最后一条已缓存消息为止的前缀；被重写的第 0 号节点让它回落到公共前缀检测的下限。

### 压缩

`compaction-basic` 不变。`selectCompactableRange` 仍锚定在第一个非系统节点，因此第 0 号节点永不被遮蔽，更后的历史内节点则可能被遮蔽；`buildSummarizationInput` 把第 0 号节点的文本作为摘要器的 `system` 回放，并按 surface 顺序回放每个被遮蔽节点的派生消息，因此区域中途的系统节点在原位被回放，摘要调用仍是对话的真实前缀。

## Alternatives considered

**只发送变化的片段作为增量。** 模型把最新的系统消息当作完整提示词，因此增量会静默丢掉每个未变化的片段。基于模型约定被否决。

**用插件配置而不是模型能力启用历史内模式。** 部署标志可能把不具备能力的模型与追加的系统消息配对，这样的模型最多把它们当作普通历史。该能力属于兑现它的路由；适配器目录已经承载逐模型的容量信息。被否决。

**永远追加，从不重新基线化。** 规则单一，但第 0 号节点会在会话整个生命周期内保持过时，压缩之后的每个请求都要携带过时的头部加替换消息。在序列开始处重新基线化不花额外代价，因为缓存在那里已经丢失。被否决。

**每次恢复都重新基线化。** 为更简单的恢复路径接受每次进程重启一次缓存未命中。缓存跨重启持续数小时到数天，而日志已经承载恢复所需的一切。被否决。

**把系统消息放在该步骤的用户消息之后。** 两个位置都在已缓存前缀之后，但模型会在读到必须应用指令的输入之后才读到指令；system 在 user 之前与最前位置的顺序一致。被否决。

**在 `agent/pre-step` waterfall 之前投影提示词。** 投影将看不到在该 waterfall 内执行的压缩，刚追加的节点可能在同一步骤内被遮蔽，请求就会把第 0 号节点的过时提示词作为唯一的系统消息携带。在 waterfall 之后投影让规则保持为构建请求所用 surface 的纯函数。被否决。

**把 provider 或 model 切换视为序列开始。** 它会在每次路由变更时把提示词折回第 0 号节点，与 tools 的情形一致。header 已经记录了该变更，缓存无论如何都会未命中，因此这条额外规则除了在循环中多一个特例之外没有任何收益。被否决。

**在明细的系统数字中报告所有存活的系统节点。** 对节点求和能直接显示被保留提示词版本的开销，但遮蔽某个已被取代版本的压缩认领就必须在系统数字与消息数字之间拆分。在追加时把被取代的提示词移入消息数字，让每次认领保持为简单的减法。被否决。

## Consequences

- 具备能力的路由上的提示词变更保住提供方前缀缓存；追加的节点在该序列的每个请求上付出自身的 token 开销，直到压缩遮蔽它。提示词在多数步骤都变化的部署，更适合把那个事实移入运行时上下文。
- 请求头部不是系统提示词唯一可能的位置：「模型看到了什么」的读者折叠 surface 并取最新的系统节点，明细的系统数字遵循同一规则。
- `request/context` 快照随声明的模式与路由一起变化，循环的决策取决于最新一条。
- 模型约定按所提供的内容记录。若发布的模型收窄了约定——例如只在有界窗口内兑现最新的系统消息——规则需要序列开始之外的重新基线化触发条件。
- 重写或重排系统消息的代理会静默破坏替换语义；真实 API e2e 的缓存命中断言是探测器。

## Testing

- `packages/core/agent-loop/tests/system-prompt-projection.spec.ts` 钉住序列延续时的追加、序列开始处对孤立第 0 号节点的重新基线化、序列开始处在有更后存活节点时的追加、空提示词的重写，以及不具备能力时只做替换的行为。
- `packages/core/agent-loop/tests/request-reconstruction.spec.ts` 钉住继承 header 下追加的节点及携带 `systemPromptUpdate` 的 `request/context`、序列开始时折回第 0 号节点、由压缩驱动的重新基线化，以及在开启序列的 `change` header 下由工具 schema 变更驱动的重新基线化。
- `packages/llm/llm/tests/service.spec.ts`、`packages/llm/llm-deepseek/tests/adapter.spec.ts` 与 `packages/test-support/llm-replay/tests/llm-replay.spec.ts` 钉住已解析模型信息上声明的模式，以及加载时对任何其他值的拒绝。
- `packages/llm/token-meter/tests/context-breakdown-projection.spec.ts` 钉住被取代的提示词移入消息数字，以及压缩认领对它的减法。
- `packages/client/ui-conversation`、`ui-chat` 与 `ui-trajectory` 的客户端测试钉住更新卡片、同一步骤 header 的去重、更新之后不存在系统变更，以及合成的轨迹 header。
- 无密钥的手写快照 `snapshots/session/system-prompt-in-history/` 在回放路由上声明该能力，通过 fixture 片段在第一次工具调用之后改变提示词，钉住追加的 `system/message`、未被触及的第 0 号节点、唯一一条 `request/header` 以及 `request/context` 中的模式。
- `packages/llm/llm-deepseek/tests/adapter.e2e.ts` 针对 `DEEPSEEK_IN_HISTORY_MODEL` 指定的模型运行两个步骤并夹带一次提示词变更，断言回复遵循追加的提示词，并断言追加后的请求比同一对话在重写最前提示词时读取更多的缓存 token；该变量未设置时跳过。
