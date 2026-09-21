# Agent Note: Definition 拥有分组业务，框架统一调度 Node／Group 输出

Status: implemented

[English](2026-09-21-conversation-build-groups.md) | 中文

## Problem

Chat 需要把连续过程内容收进可展开的组，同时保留独立回复、用户输入和轮次控件。Compact、Detailed、Expanded 必须共用分组结果；切换模式不能通过删除组容器、移动成员父级或更换 key 重建 React 实例。

Chat Builder 汇总整个目标的节点及索引。在其中固定创建 Chat 过程投影器，即使把部分缓存移到通用层，仍然让 Builder 拥有业务分段。业务 Definition 才是这些规则的注册点。

过程组与 Step 正交：同一个 Assistant Node 可以把推理放在组内、回复放在组外，回复后的工具进入后面的组。Step 编号范围无法描述这种成员归属。现有事件 Definition 逐个解释事件，分组则需要这些 Definition 已经解释完成的节点。

## Decision

分组基础机制提供独立的节点输入 `ConversationGroupDefinition`、注册表及 Session 内上下文、Builder 通用输入与发布、按键 Group 存储及两种 React 分支。基础机制不注册真实 Chat 分段及 PR #4565 展示，[业务迁移提案](../../proposed/feature/2026-09-20-chat-work-details-migration.zh.md)保留这些需求。[子系统参考](../../../../docs/subsystems/conversation.zh.md#group-definitions)与[源码类型](../../../../packages/client/ui-conversation/src/client/contract/groups.ts)拥有当前 API 细节。

### 职责

| 要求 | 含义 |
|---|---|
| 分组业务属于已注册 Definition | 成员、分段、回复、steering、重试、摘要和缓存失效放在一起。 |
| Builder 与 assembler 做统一工作 | 提供输入、调度 Definition、校验引用、复用身份并发布，不创建具体分组类。 |
| 产品行为以 PR #4565 为准 | 保留行为，不复制其侵入性实现。 |
| React 根循环只有两种 kind | 根顺序包含 NodeReference 和 GroupReference，不引入另一套布局对象模型。 |
| 所有模式共用分组 | 模式不进入 Definition 输入、key 或父级选择。 |
| 不采用 buildLayout | ConversationViewDefinition 保留现有职责。 |
| 先基础、后业务 | 基础 PR 不包含真实 Chat 分组、摘要、通知或页脚变化。 |

### 与已有记录的关系

| 记录 | 关系 |
|---|---|
| [业务节点组装](2026-08-09-client-conversation-node-assembly.zh.md) | 保留事件匹配、Context、Location、每个 Context 一个业务 Node 及目标 Builder，分组增加另一种输入类别。 |
| [展示策略与过程分组](../../proposed/architecture/2026-09-20-chat-presentation-policy-and-step-groups.zh.md) | 保留 Definition 归属、局部订阅和模式无关要求，以新分组机制替代事件 fold 及 Step 范围成员推断。 |
| [工作过程展示迁移](../../proposed/feature/2026-09-20-chat-work-details-migration.zh.md) | 保留产品范围及迁移跟踪，基础机制本身不代表这些功能完成。 |

这些记录仍有独立理由，保留有效状态。跨 View 导航与 `toolCallFocus` 不属于本次改动；不引入 View 句柄、Label Slot 或资源导航架构。

## Definition 输入、状态与注册

`ConversationNodeDefinition` 保留 `match/start/update/publication/buildLocationData/buildViewNode`，`ConversationViewDefinition` 保留 `target/create/isActive/toolCallFocus`。分组业务通过 `ctx.uiConversation.groups.register(processGroupDefinition)` 注册，不加在上述已有 Definition 的回调中。

- 每个目标只有一个 Group Definition，拥有完整分组语义。重复目标注册报错，不选择胜者，也不叠加策略。
- 注册要求已有 View 目标，但不构造 Builder。首次激活取得 Builder 后检查 `groupInput()`，缺少输入方法时报错。未分组目标不要求该方法，也不分配 Group 状态。
- 每个 Session 为已注册 Definition 拥有一个派生上下文。`create()` 初始化 State，不是 `turn/start` 事件，也不是事件 Definition 的唯一 start Match。Definition 对象不保存跨 Session 的可变状态。
- `update(context, input)` 返回框架采纳的 State。`buildGroups(context)` 物化待输出结果，不重新解释事件，不因重复读取增加计数。替换输入要求输出完整根序列和组替换，避免已移除节点留下悬挂引用；apply 的 `null` 保留结果。
- `replace` 提供目标顺序、同步 `readNode` 和时间线；`apply` 还提供投影后的节点前后值及 `changedTurns`。读取函数仅在当前同步调用中有效，不保留到 State。
- 节点数据仍在目标 Node Store。仅正文更新保留顺序数组；旧值在 Builder 安装投影结果前记录，也覆盖目标投影额外改变的节点。
- `ConversationLocationIndex` 从边界事件和 Location 数据写入累计变化轮次。assembler 将同一批变化交给全部被更新目标，覆盖没有节点 upsert 的 Turn 结束。直接调用未分组 Builder 的调用方可省略该字段。
- 通用 GroupDataMap 在注册、存储及读取之间关联目标和 Data。未声明的目标没有组载荷类型，业务消费方不通过 unknown 断言恢复摘要类型。

## Node／Group 引用与更新

`NodeKey` 表示既有 Context Node，`GroupKey` 在 Session、目标及 Definition 内标识组。`NodeReference` 与 `GroupReference` 在 `RenderEntry` 中地位相同。`GroupSnapshot<Data>` 单独保存组的不可变数据与有序 NodeReference 成员，不混入根顺序。创建 Group 不增加 Session 事件或执行生命周期。

`groupPart` 是渲染器拥有的节点部分，例如 reasoning 或 response，省略表示整个 Node。部分引用也可以独立位于根层。部分内容的完备性和归属由业务渲染器负责，不由框架判断。组数据描述状态、计数或摘要，不复制 Node 正文、工具结果或可变业务 State。组不携带 renderer 字段、CSS、坐标、React 元素、导航或嵌套组。

| 更新 | 含义 |
|---|---|
| apply 输入省略 `entries` | 保留根顺序；替换输入必须提供完整序列。 |
| 提供 `entries`，包括 `[]` | 替换完整根序列，空数组清空根序列。 |
| `groups: { kind: 'replace', snapshots }` | 替换完整组记录，移除未包含的旧组。 |
| `groups: { kind: 'apply', upserts, removes }` | upsert 完整快照，只按具名 GroupKey 删除组。 |
| 仅数据变化 | upsert 新 data，复用 members，省略 entries。 |
| 仅成员变化 | upsert 该组完整的新成员数组，不替换全部组。 |
| 仅根顺序变化 | 提供 entries，apply 的 upserts/removes 为空。 |
| 解散一个组 | 原子地用成员替换根引用并删除 GroupKey，保留原 Node。 |

`entries` 与 `groups` 属于同一安装批次，不是独立发布通道。删除成员引用不删除 Node。upsert 需要快照内容，删除只需要身份。真实成员归属变化可以让 React 重挂载成员，但模式切换不能解散组。

存储在修改前校验最终提交结果：每个根 Group 恰有一份记录和一个根位置；Node 引用存在；重复 upsert、重复删除及同时 upsert/删除均报错。全部根和成员中，每个 `(NodeKey, groupPart)` 最多出现一次。整 Node 不能与自身任一部分共存，不同部分可以占据不同位置。允许引用在一次原子更新中移动位置。

GroupStore 按 GroupKey 索引记录和来源，不反复查找数组。等价根数组、成员数组及未变化组快照保留身份。仅数据 upsert 只检查提交的快照，不扫描根、未变化成员或 Node。完整替换重新校验引用，仍按 key 对齐结果。Definition 缓存拥有业务计算，GroupStore 拥有已安装结果及通知。

## 组装时序与生命周期

1. BoundConversation 从现有 feed 接收 append、prepend、replace 或 Assistant settlement。
2. assembler 运行既有 Node Definition 匹配、状态更新及必要的 Context 重放。
3. 既有 immediate/animation-frame/none 节奏调度发布，分组不增加计时器或事件订阅。
4. flush 依次物化 Step、Turn Location 数据及目标 Node。
5. Builder.replace/apply 安装投影后 Node、目标顺序及索引，保留 GroupInput，不通知独立来源。
6. assembler 取得目标已注册的 Group Definition 上下文，以 builder.groupInput() 调用 update，采纳返回 State。
7. 调用 buildGroups，校验并安装结果，安装目标快照。
8. 全部受影响目标安装完成后，调用 Builder.publish，发布 Group 来源和 Location 数据。
9. BoundConversation 发布既有根 Conversation 来源。

首次激活的 replaceView 与普通 flush 使用同一目标更新函数。未激活目标不创建 Builder 或 Group 上下文。注册重建一并采纳 View 和 Group Definition，丢弃被替换或删除的 Group 上下文并清空旧观察结果。未替换的 Definition 复用按键存储。React 接收 Node Store 身份，让存储替换时重新绑定按键钩子，不替换 key 或 DOM 实例。

已注册的 View Definition 被移除后，分组计算暂停并清空派生结果，Group Definition 注册仍保留。View 恢复时沿现有替换流程，从当前已加载时间线重建。首次注册 Group 时仍拒绝缺失的 View 目标；切换页签不会注销 View。

分组不重放原始事件。Node Definition 先处理重放，分组消费其最终目标替换或变化。prepend 可以修正边界并真实移动成员。Definition 处理新旧 Location 和变化轮次，不把分页或每个正文分片都当作完整历史重新分组。

## 具体实现落点

| 层／文件 | 职责 |
|---|---|
| [groups.ts](../../../../packages/client/ui-conversation/src/client/contract/groups.ts) | Group Definition、输入、引用、更新、类型数据映射及读取器。 |
| [conversation.ts](../../../../packages/client/ui-conversation/src/client/contract/conversation.ts) | Builder 可选 groupInput/publish 和快照存储 grouped 读取，已有 Node/View Definition 不变。 |
| [group-registry.ts](../../../../packages/client/ui-conversation/src/client/conversation/group-registry.ts) | 复用注册表基类，目标唯一性、类型化注册及 effect/disposer 生命周期。 |
| [assembly.ts](../../../../packages/client/ui-conversation/src/client/conversation/assembly.ts) | UiConversation.groups 与现有 binding 重建通知。 |
| [assembler.ts](../../../../packages/client/ui-conversation/src/client/conversation/assembler.ts) | 首次激活和 flush 共用调度，上下文归属、安装及发布。 |
| [location-index.ts](../../../../packages/client/ui-conversation/src/client/conversation/location-index.ts) | 累积变化轮次，覆盖仅生命周期和 Location 数据变化。 |
| [group-store.ts](../../../../packages/client/ui-conversation/src/client/conversation/group-store.ts) | 原子引用校验、按键来源、数组复用及局部发布。 |
| [chat-snapshot-builder.ts](../../../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts) | 记录投影后节点增量及稳定顺序，推迟来源通知，不持有过程分组类。 |
| [ChatView.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) | 读取可选根引用并切换 node/group，无分组时使用既有 Node 顺序。 |
| [ChatGroupSeat.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx) | 稳定组父级、仅成员订阅及嵌套 Node 容器。 |
| [ChatNodeSeat.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx) | 既有 Node 来源及渲染器、groupPart 传递、独立部分锚点及 Store 替换时重绑定。 |
| [slots.ts](../../../../packages/client/ui-chat/src/client/contract/slots.ts) 与 [apply.ts](../../../../packages/client/ui-chat/src/client/apply.ts) | 使用现有按键钩子注入 Group 来源，不改 Slot 引擎。 |

## React 读取与展示

根层通过既有 useConversation 来源选择 `views.grouped('chat')?.entries`。按键 Group 钩子沿用现有注入，Group 容器选择 members。成员使用既有按键 Node 来源。根列表移除组件前，已删除 Group 来源可能先返回 undefined，因此选择器允许不存在，并保持钩子顺序稳定。

React key 由引用 kind、NodeKey/groupPart 或 GroupKey 的无歧义元组派生，不另设 RenderKey 类型或 renderer 分发字段。Compact、Detailed、Expanded 保留同一组容器及成员父级，展示变化不重新运行 Group Definition，也不选择不同的根分支。

稳定 Group 父级使用 `div` 与 `display: contents`，自身不产生布局盒子。CSS 继承仍然可用，业务样式适配子级／兄弟选择器并拥有可测量的正文容器。CSS 变量和几何信息都不进入 Definition。阅读位置采样测量成员 Node，保留部分专属锚点；既有轮次导航将原 NodeKey 解析到它的第一个可见部分。

## Alternatives considered

**Builder 持有 buildGroups 或过程投影器。** 不采用，目标汇总器仍然拥有业务规则，把缓存移到通用层不能改变归属。

**在原事件 Definition 加 buildGroups，不补输入。** 不采用，回调名称不能提供跨节点输入、生命周期变化或重建语义。

**Group Definition 重放原始事件。** 不采用，它重复 Assistant、Tool、Message 解释，并可能偏离 Builder 最终可见顺序。

**ConversationViewDefinition.buildLayout。** 不采用，它把目标工厂扩展成业务布局回调，没有独立注册业务 Definition。

**每个 Group 一个事件 Context。** 不采用，边界取决于前方可见内容，不由一个携带组起点身份的事件决定。目标内派生上下文也能处理 Turn 外独立节点。

**依赖图、ViewItem 类、工厂、嵌套组或策略叠加。** 本阶段不采用，一个目标输入和一份非嵌套分组输出覆盖当前诉求。

**独立的数据更新操作。** 不采用，复用 members 的不可变快照 upsert 已经能更新摘要，不替换其他组。

**Group Definition 同时增删 Node 和 Group 实体。** 不采用，Node 数据已有所有者，引用对称不需要第二个 Node 所有者。

**Expanded 移除组容器。** 不采用，即使 key 不变，父级改变仍会重挂载成员。

## Verification

- [Group 存储测试](../../../../packages/client/ui-conversation/tests/conversation-group-store.client.spec.ts)覆盖原子引用校验、根与成员身份复用、局部发布，以及删除组但保留原 Node。
- [分组调度测试](../../../../packages/client/ui-conversation/tests/conversation-groups.client.spec.ts)覆盖首次激活、仅生命周期输入、注册替换、View 移除与恢复，以及完整替换输出。[Assembler 测试](../../../../packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts)覆盖变化轮次报告和 Location 数据来源。
- [Chat 渲染测试](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx)保留模式切换时的组件状态，重绑定替换后的 Node 存储，传递独立部分，并省略未引用 Node。[视口测试](../../../../packages/client/ui-chat/tests/chat-viewport.client.spec.ts)覆盖组内阅读锚点、历史前插及部分感知的轮次导航。

## Consequences

- 这是明确的框架扩展，包含新输入协议、注册表、上下文、发布阶段及读取器，不只是增加一个回调。
- 目标内 State 不会自动让业务更新局部化，Definition 必须区分正文增长与结构变化，并索引受影响范围。
- Node 顺序及可见性只有 Builder 一个所有者，分组不独立排序原始事件，也不在通用层再次推断成员。
- 稳定挂载不消除布局、绘制或保留内存的成本，不宣称实测延迟或最优性能。
- 真实组拆并、首成员变化及分页修正可以改变身份，模式切换保证不禁止这些正常变化。
- 隐藏部分的揭示、选择复制、中断提示、组开合与外层 Turn 联动需要业务适配。基础测试使用混合引用，不启用真实分组。
