# Agent Note: Chat 展示策略通道与过程分组的基础架构

Status: proposed

[English](2026-09-20-chat-presentation-policy-and-step-groups.md) | 中文

## 问题

Chat 的「对话显示」设置在本提案开始时只有两档：`normal` 不折叠、`compact` 在轮次结束后把过程行折进一个整轮控件。设置值的流向是：`TranscriptViewPolicy.mode` 观察量注入 ChatView，ChatView 用 `useTranscriptView` 读成一个布尔值 `compactTranscript`，再作为 prop 传给 `ChatNodeList`，再传给每一个 `ChatNodeSeat`。另一个全局布尔值 `hasMore` 走同一条路，以 `historyIncomplete` 的名字进每个 seat。两个值一变，全部 seat 重渲染一遍，哪怕只有可折叠的那几个输出真的变了。

产品要把这个设置改成三档：简洁、详细、完全展开；并在简洁和详细两档里把回复之间的连续过程行归成可折叠的组。PR #4565 做过一次完整实现，合并八分钟后因性能回退被整体撤回。合并前后在本机的对照实测：长会话分页耗时 +27%，DOM 节点 +23%，堆内存 +14%，Trajectory 切换 +10%，全部仍在 CI 预算内；仓库现有六个基准没有任何一个覆盖「流式期间 reasoning 或工具 chunk 进入活动分组、分组重投影、seat 重渲染」这条它新增的热路径。

审阅那次实现，问题不在业务需求，在选型：

- 模式被当成列表结构的输入。`ChatNodeList` 订阅整表 `layout`，按 range 生成 wrapper 组件；完全展开模式下 wrapper 消失。模式切换等于整棵列表重挂载，任何一次重新分组都重建 wrapper 的 key。
- 模式进了 `ChatNodeOwnerProps`。每个 seat 的 owner 对象随模式变，所有业务渲染器跟着重渲染，包括与模式无关的用户消息、工具行、压缩标记。
- 同一个 Assistant 节点在 seat 里被拆成 reasoning 与 response 两份派生对象，只为了让 wrapper 在 DOM 上包住前者不包住后者。master 的 `AssistantMarkdown` 早有 `reasoningHidden` 与 `revealProcess`，靠隐藏状态就能只藏 reasoning。
- 基础设施行的 Chat 可见性由消费方过滤函数在四处各判一遍，而节点本身有 `visibility` 字段由 Definition 决定。

再往下一层，是一个信息流上的两难：分组的行要出现在成员之前，从组打开那一刻就该存在；但它要显示的内容，只有看到整轮所有事件的人才知道。事件驱动的 Context 模型里每个 Context 只收自己的事件，能看到整轮的只有 turn 级 Context，而它只能产出一个节点。

本记录给出一套基础架构，让三档模式与分组落地时满足下面的约束，并让后续产品变化只落在少数节点上。

三档设置、展示策略通道与按轮折叠资格已实现；step-group 仍是提案。当前实现、已提交范围和未完成项以[迁移进度表](../feature/2026-09-20-chat-work-details-migration.zh.md)为准，下面的分组状态机与改动清单不表示已经交付。

## 目标与约束

下表是评审阶段已经确认的裁决，本方案不再重新讨论它们。

| 编号 | 裁决 | 含义 |
|---|---|---|
| 1 | 分组结构在 Definition 层定义 | 组的开合、成员范围、摘要由一个多重匹配本轮事件的 Definition 折叠出来，不由渲染层扫描节点得到 |
| 2 | 有限刷 seat | 切模式只重渲染 presentation 真正变化的 seat；流式 chunk 只重渲染所属 seat 和它所在组的组头；用户消息、回复、turn-tail 在这两种变化下零重渲染 |
| 3 | 一个 Context 一个节点 | 不引入「一个 Context 产出多个节点」，理由是绝大多数 Context 只会有一个元素，数组化让内存更零散 |
| 4 | 模式不开关 Definition | 注册变化会触发 registry 重建与全量重放，所有 seat 必刷；Definition 必须与模式无关 |
| 5 | 折叠按轮判定 | 一轮只要自己的 `turn/start` 已加载就可以折叠；被分页切开的最老一轮保持展开，本轮不优化 |
| 6 | 允许改 ui-conversation | 引擎可以改，但只做让方案正确成立所必需的小改动 |
| 7 | 初始实现范围 | 初始阶段只写代码与本记录；测试与其他文档在 CI 修复阶段补齐 |

有一条前置澄清：接受「切模式全屏重排版」不等于接受「所有 seat 重渲染」。浏览器重排是几何结果，seat 重渲染是 React 组件函数重跑，后者才是这里要限制的量。

## 可行的路线

围绕「组头这一行的身份从哪来、内容从哪来」，可行的路线有五条。

**路线 A，头成员的 seat 画组头。** 列表不变，builder 算出分组后告诉第一个成员的 seat「你是组头」，该 seat 在自己上方画标题，其余成员 seat 用现有 `hidden` 机制藏起来。零新概念。缺点是 seat 里出现「自身可见但只显示标题」的第三种状态，且标题寄生在一个业务节点的 seat 里。

**路线 α，每步一个 Context 当组头。** 增加一个 id 为 `turn:step` 的 Definition，在构建时读上一步的 `assistant-step` 数据判断自己是否新组开头，是则产出组头节点。组的内容由另一个 turn 级 Definition 发布成 Turn 数据供渲染器读取。

**路线 β，一个 Context 产出多个节点。** turn 级 Definition 一个人产出整轮控件加 N 个组头。

**路线 γ，父 Context 派生子 Context。** turn 级 fold 在开组时生成一个 `step-group` 子 Context 并把后续事件转发给它，子 Context 有自己的单个节点。引擎需要新增转发原语与重放级联。

**路线 δ，Definition 拥有结构，builder 物化行。** turn 级 Definition 折叠出组列表并发布为 Turn 数据；Chat builder 据此物化组头节点并给成员写归属；seat 用组合 selector 决定隐藏；引擎给 `ViewBuilder.apply` 的入参加一份「本次 flush 哪些 Location 数据换了引用」。

## 备选方案与取舍

**每组一个 Context 无法成立。** 引擎要求 `match(event)` 只看单个事件算出 id，「第几组」取决于前面有没有回复，单个事件算不出。这不是实现难度，是契约上的不可能。

**路线 α 与裁决 2 冲突。** 组头身份能算出，但内容要读整轮一份 Turn 数据，任何一组变化全轮组头都重渲染。改成去读 `turn.steps` 里后面几步的数据，又碰上组头节点不会因为后面的步到来而重建，读到的是陈旧引用。

**路线 β 被裁决 3 否决。** 见上表。

**路线 γ 现在不值。** 它在所有权上最纯，但要给 assembler 加转发与重放级联，是几百行的引擎核心改动。本记录把它保留为备选，条件写在末尾。

**路线 A 作为退路保留。** 如果 builder 物化节点在实践中被否决，退到 A；两者的结构来源相同，只差组头这一行的承载。

选择路线 δ。

## 方案

### 数据流

```
事件流
  ──▶ step-groups Definition（turn 级 fold，多重匹配本轮事件）
        ──▶ Turn 数据 step-groups：组列表，每组一个对象
              ──▶ Chat builder
                    ├─ 物化组头节点：一组一个 key，data 即组对象
                    └─ 成员归属：按 step 映射到 key，写进 per-key presentation
                          ──▶ seat：hidden = f(策略字段, 角色, 展开状态)
                          ──▶ 组头渲染器：读自己节点的 data
展示策略
  ──▶ 渲染器：按 kind 注入的 hooks，选单个字段
  ──▶ seat：组合 selector，选出的是自己的结论
```

引擎改动只有一处：assembler 在 flush 时把「哪些 Location 数据换了引用」随 `apply` 入参交给 builder。

### 各层职责

| 层 | 拥有 | 明确不拥有 |
|---|---|---|
| `step-groups` Definition | 组的开合、`headStep`、`closeStep`、工具计数与名称、运行中的工具；作为 Turn 数据发布 | 任何视图节点；成员是哪些节点 |
| Chat builder | 组头节点的身份与生命周期；成员归属；`turnStarted`；per-key presentation 的身份比较发布 | 读事件；自己算业务结构 |
| 展示策略对象 | 枚举到能力字段的映射 | 任何节点或 seat 状态 |
| seat | 用策略字段、角色、store 状态合成 hidden；把组的开合能力交给组头渲染器 | 判断组的边界 |
| 组头渲染器 | 标题、箭头、点击开合 | 组的内容来源 |
| assistant-step 渲染器 | 是否显示已完成推理的首行预览；作为组的关闭者时隐藏推理部分 | 组的边界 |

### 组头节点的身份与生命周期

组头节点的 key 是 `step-group:${turn}:${headStep}`。`headStep` 在组打开那一刻就确定，之后任何事件都改不了「谁是第一个」，所以组头节点从打开起就存在并被复用，运行中不会换 key。组关闭只是它 data 里的 `closed` 从 false 变 true。

组头节点的锚点是该组头成员节点锚点减去一个合成偏移，位置紧贴在第一个成员之前。头成员的 Assistant 节点在流式期间锚在第一个可见 chunk，落盘后锚在消息事件，锚点会移动一次；组头随之移动一次，这是一次结构性更新，与 Assistant 节点自己的结构性更新同时发生，不额外增加次数。

组头节点属于整轮过程的一部分：整轮折叠时它随成员一起隐藏。它不在 `TURN_PROCESS_INDEPENDENT_KINDS` 里。

组头节点的 data 就是 fold 发布的组对象。已关闭的组对象引用永不改变，因此已关闭组头的 source 永不通知；正在运行的组每来一个改变它的事件换一个对象，只有这一组的组头重渲染。

### fold 状态机

`step-groups` Definition 的 id 是 turn 号，在 `turn/start` 上启动，匹配与 `turn-process` 同一批事件。State 是 `{ turn, groups, open }`，`groups` 是组对象数组，`open` 是当前打开组的下标或空。

| 事件 | 转移 |
|---|---|
| `tool/call` | 没有打开的组则以该事件的 step 开新组；计数加一；记录 distinct 工具名；把 callId 加入运行集合 |
| `tool/result` 追加 | 从运行集合移除 callId |
| `assistant/live-chunk` 推理 delta 含可见字符 | 没有打开的组则以该 chunk 的 step 开新组 |
| `assistant/live-chunk` 文本 delta 或文本块结束含可见字符 | 有打开的组则以该 chunk 的 step 关闭它 |
| `assistant/message` 追加 | 消息含可见推理则按推理规则处理，含可见回复则按文本规则处理；顺序是先推理后文本 |
| `turn/end` | 有打开的组则标记为被轮次结束关闭 |
| `step/start`、`step/end`、`llm/retry` | 不改变状态；重试行不属于任何组 |

三条不变量：

- 幂等。开组时已有打开的组则无操作；关组时组已关闭则无操作。live chunk 与落盘消息重复描述同一内容不会开两次或关两次，历史重放只有落盘消息也能得到同样的组列表。
- 引用稳定。State 没变时 `update` 返回原对象；`groups` 数组只在组列表变化时换引用；已关闭的组对象永不替换。
- 只向前折叠。不读邻居 Context，不读节点，不向后看。

Turn 数据发布：`buildLocationData` 只在 turn 阶段返回值，`groups` 引用不变时返回上一次发布的值，引擎据此不重新发布。没有 `turn/start` 的历史窗口用与 `turn-process` 相同的兜底：从已有匹配折叠出 State。

发布节奏：live chunk 走动画帧合并，其余立即。

### 成员归属规则

归属由 builder 按 step 判定，不用 seq 区间，因为 live chunk 的 seq 与落盘事件的 seq 不在一个尺度上。

| 节点 | 规则 |
|---|---|
| `tool-call`，step 为 s | 属于 `headStep ≤ s` 的最后一组。文本在同一 step 关闭了上一组之后的工具调用，会由 fold 以该 step 开出新组，所以「最后一组」总是正确的那一组 |
| `assistant-step`，step 为 s，且某组 `closeStep === s` | 角色为关闭者。节点保持可见；组折叠时只隐藏它的推理部分，用现有 `reasoningHidden` 机制 |
| `assistant-step`，step 为 s，其余情况 | 属于 `headStep ≤ s` 且 `s` 未越过 `closeStep` 的组，角色为成员 |
| `model-retry`、`turn-error`、`turn-max-tokens`、`turn-tail`、`user`、`steering` | 不属于任何组 |

归属只在组列表变化时重算，成本是该轮节点数。流式 chunk 不改变组列表时，成员的 presentation 不发布。

组头行锚在最早的成员之前。一个组如果只有关闭者的推理而没有任何成员，比如一步里先推理后回复，组头行就锚在关闭者之前，这样被隐藏的推理仍然有一行可以点开。

### 分组变化怎样到达 builder

fold 只发布 Turn 数据，没有视图节点。engine 的 `flush` 在 Location 数据有变化时会把 `timelineDirty` 置真并对所有活跃目标调用 `apply`，但 builder 不知道是哪一轮的哪个 key 变了。依赖「同一轮总有别的节点也在这次 flush 里变了」去推断，是巧合不是契约。

所以给 `ConversationViewBuilder.apply` 的入参增加可选的 `changedLocationData`：本次 flush 里换了引用的 Location 数据清单，每项含 `kind`、`turn`、可选 `step`、`key`。assembler 在 `applyDirtyLocationData` 里本来就逐条比较了前后引用，只是把比较结果收集起来交给 builder。Chat builder 只取 `key === 'step-groups'` 的轮次做重投影。入参可选，不传时 builder 退化为按本次 upsert 涉及的轮次重投影。

### seat 的 hidden 合成

seat 不再接收 `compactTranscript` 与 `historyIncomplete` 两个 prop。它通过 `usePresentation` 读策略，但选出的不是模式，而是自己的结论：

```ts
declare function usePresentation<T>(select: (policy: {
  stepGrouping: 'collapsed' | 'none'
  foldCompletedTurns: boolean
}) => T): T
declare const group: { readonly headStep: number } | undefined

const grouping = usePresentation(p => group === undefined ? 'none' : p.stepGrouping)
const foldCompleted = usePresentation(p => p.foldCompletedTurns)
```

不在任何组里的 seat，`grouping` 在三档下都是 `'none'`，值没变就不重渲染。`foldCompletedTurns` 在三档下都是 true，同理。selector hook 的底层是 `useSyncExternalStoreWithSelector`，只有选出的值变化才重渲染。

三个隐藏来源合成一个 `hidden`：

| 来源 | 条件 | 揭示动作 |
|---|---|---|
| 整轮折叠 | 现有规则，`turnClosed && turnStarted && 有回复` 且未手动展开 | 打开整轮 |
| 组折叠 | `grouping === 'collapsed'`、角色为成员、组未手动展开 | 打开该组 |
| 组头在完全展开档 | 角色为组头且 `grouping === 'none'` | 无 |

关闭者节点的推理部分单独隐藏：seat 通过 owner props 里的 `stepGroup.reasoningHidden` 告诉 assistant-step 渲染器。

组的展开状态进 chat store，key 是 `turn` 加 `headStep`，与整轮的手动展开状态并列。

### 刷新范围

下表是这套结构给出的保证，也是下一轮渲染次数测试的断言表。每一行断言的是精确集合，不是上限。

| 外部变化 | 允许重渲染的 |
|---|---|
| 运行中的组来一个推理 chunk | 该 assistant seat |
| 运行中的组来一个 `tool/call` | 该 tool seat，加这一组的组头 |
| 回复出现，组关闭 | 该 assistant seat，加这一组的组头；成员归属重算只发生在开关组时 |
| 新组打开 | 新组头进 `order`，一次结构重排；其他 seat 不刷 |
| 模式在简洁与详细之间切换 | 仅有已完成推理的 assistant-step 渲染器 |
| 模式切到完全展开或切回 | 仅成员与组头 seat |
| `performanceUsage` 切换 | 仅 turn-tail |
| 加载更早一页 | 新增 seat，加 presentation 变了的历史 seat |
| 语言切换 | 全部，作为对照 |

### 展示策略对象

持久化的枚举与运行时词汇分开。枚举 `TranscriptViewMode` 是 `compact`、`detailed`、`expanded`，存档里的旧值 `normal` 读取时映射为 `detailed`，不回写。运行时词汇是派生的 `ChatPresentationPolicy`：

| 字段 | compact | detailed | expanded |
|---|---|---|---|
| `foldCompletedTurns` | true | true | true |
| `stepGrouping` | collapsed | collapsed | none |
| `settledReasoningPreview` | false | true | true |

映射只存在于一处。每档对应一个常量对象，同一档永远同一引用，所以派生观察量不需要自己的订阅簿记：`getSnapshot` 是查表，`subscribe` 直接转给模式观察量。

渲染器不比较枚举，只 select 自己需要的字段。策略观察量按 kind 注入：assistant-step 的注册通过 `inject.hooks.presentation` 拿到它，与 turn-tail 注入 `performanceUsage` 是同一写法。以后加第四档只改这张表，渲染器一个不动。

### 按轮折叠

per-key presentation 增加 `turnStarted`，来源是该轮 `turn/start` 是否在加载窗口内。seat 的折叠资格由 `turnStarted` 替代原来的全局 `!historyIncomplete`。分页加载完成时不再有任何全局 prop 变化，只有新增节点与它们所在轮的 presentation 变化。

### 复杂度契约

| 场景 | fold | builder | 发布 |
|---|---|---|---|
| 内容型 chunk，不改变组边界 | O(1) 状态转移，返回原对象 | 无重投影 | 零 |
| 改变组边界的事件 | O(1) | 只重投影所属轮，成本为该轮节点数 | 该轮内事实变化的 key |
| 结构变化与分页 | 按匹配的事件数 | 全量一次 | 事实变化的 key |
| 模式切换 | 无 | 无 | 无；重渲染由 seat 与渲染器的 selector 决定 |

## 改动清单

| 包 | 文件 | 改动 |
|---|---|---|
| ui-conversation | `contract/conversation.ts` | 新增 `ConversationLocationDataUpdate`；`ConversationViewBuilder.apply` 入参增加可选 `changedLocationData` |
| ui-conversation | `conversation/assembler.ts` | `applyDirtyLocationData` 收集换了引用的 Location 数据并随 `apply` 传出 |
| ui-conversation | `index.ts` | 导出新类型 |
| ui-chat | `chat-settings.ts` | 三档枚举；schema 接受旧值 `normal` |
| ui-chat | `transcript-view.ts` | 读取时 `normal` 映射为 `detailed` |
| ui-chat | `presentation-policy.ts` 新增 | 策略对象、映射表、派生观察量 |
| ui-chat | `settings/TranscriptViewRow.tsx` | 三个选项 |
| ui-chat | `locale.ts` | 三档文案；组头文案 |
| ui-chat | `contract/slots.ts` | `ChatViewInjected.hooks.presentation`；`PresentationInjected`；`ChatNodeOwnerProps.stepGroup`；`StepGroupOwnerProps` |
| ui-chat | `contract/snapshot.ts` | `ChatTurnProcessPresentation.turnStarted`；`ChatNodeGroupPresentation`；`processSource` 的值改为 per-key 组合对象 |
| ui-chat | `contract/chat-nodes.ts` | `StepGroupChatData` |
| ui-chat | `contract/store.ts`、`stores.ts` | 组的手动展开状态与动作 |
| ui-chat | `conversation-nodes/common.ts` | 组头锚点偏移 |
| ui-chat | `conversation-nodes/step-groups.ts` 新增 | fold Definition 与 Turn 数据声明合并 |
| ui-chat | `conversation-nodes/step-group-nodes.ts` 新增 | 组头节点物化与成员归属投影 |
| ui-chat | `conversation-nodes/turn-process-presentation.ts` | `turnStarted`；组合 per-key presentation |
| ui-chat | `conversation-nodes/chat-snapshot-builder.ts` | 接入物化投影；消费 `changedLocationData`；store 支持删除 key |
| ui-chat | `conversation-nodes/register.ts` | 注册 fold Definition |
| ui-chat | `chat/ChatView.tsx` | 删除 `compactTranscript` 与 `historyIncomplete` 的传递；传 `usePresentation` |
| ui-chat | `chat/ChatNodeSeat.tsx` | 组合 selector；三个隐藏来源；`stepGroup` owner props |
| ui-chat | `chat/AssistantNodeView.tsx`、`chat/AssistantMarkdown.tsx`、`chat/ReasoningRow.tsx` | 注入策略；已完成推理的预览开关；关闭者的推理隐藏 |
| ui-chat | `chat/StepGroupNodeView.tsx` 新增 | 组头渲染器 |
| ui-chat | `chat/register-node-renderers.ts` | 注册组头渲染器；给 assistant-step 注入策略 |
| ui-chat | `apply.ts`、`index.ts` | 创建策略观察量并注入；导出类型 |

上述清单保留完整分组方案；独立功能已经更新 README、i18n 配对文件及 slot catalog。测试与快照进度见迁移记录，未完成的分组改动不随这些更新自动完成。

## 验收标准

分组相关验收仍待实现；独立展示功能的验证进度见迁移记录。

**渲染次数隔离测试。** 在现有 `chat-view.client.spec` 的挂载方式上加计数：React Profiler 的 `onRender` 按 seat 计数，测试专用的计数渲染器注册进 `conversation.chat.node` 按 kind 计数。刺激与期望按「刷新范围」一节的表逐行断言精确集合。

**发布次数测试。** 同样的刺激下统计每个 key 的 source 通知次数，断言精确集合。

**fold 状态机单测。** 喂事件序列，断言组列表：开组、关组、同 step 先文本后工具开新组、轮次结束关组、幂等性、已关闭组对象引用不变、只有落盘消息的历史重放得到相同组列表。

**成员归属单测。** 给定组列表与该轮节点，断言每个 key 的角色。

**基准补位。** `conversation-fold` 增加带推理与工具的增量 apply 场景；`long-session-browser` 增加带工具与推理的流式 fixture。这是墙钟兜底，不是门禁。

## 风险

- **builder 产出节点的边界。** 这是这套架构里第一次由视图 builder 产出节点。边界写死为：builder 只能从 Turn 或 Step 数据物化行，不能读事件，不能自己算业务结构。合成 key 用 `step-group:` 前缀，Context key 以数字开头，不会冲突。如果实践中被否决，退到路线 A。
- **组头锚点随头成员移动一次。** 头成员是流式 Assistant 时，落盘让锚点从首个可见 chunk 移到消息事件，组头跟着移动一次。与 Assistant 自己的结构性更新同时发生。
- **三档在本轮的实际差异。** 简洁与详细目前只差已完成推理的首行预览；运行中的详情标题、类别摘要等产品特性不在本轮。策略表已为它们留了位置。
- **分页与半截轮。** 被分页切开的最老一轮不折叠、不分组；归属只按 step 计算，不受分页影响。
- **组头文案。** 本轮只有「正在处理」与「已完成处理」加工具调用次数，类别摘要留给产品层。
- **流式 chunk 的 step 字段。** `assistant/live-chunk` 事件携带 `step`，与 `turn-process` 的用法相同；若 chunk 缺少 step 则不开组。

## 备选保留：父 Context 派生子 Context

如果 builder 物化节点在使用中暴露出比预期更多的边界问题，替代方案是给引擎加一个原语：Context 在 `update` 中可以派生一个指定 kind 与 id 的子 Context，并把后续匹配转发给它；子 Context 有自己的单个节点、自己的发布节奏与 Location。父 Context 重放时子 Context 按 id 对齐，未再派生的子 Context 按现有撤回规则转为隐藏。

它的收益是行的身份与内容都回到 Definition 层，一组一个 Context，没有数组碎片。代价是 assembler 要新增转发与重放级联，且 `match` 之外多出一条 Context 创建路径。切换条件：builder 物化节点的边界在两个以上业务里被突破，或成员归属的按 step 规则出现无法用 step 表达的用例。
