# Agent Note: 准备阶段的工具参数增量扫描与参数顺序

Status: implemented

[English](2026-09-24-preparing-tool-arguments.md) | 中文

## 问题

[三阶段工具调用](2026-09-22-tool-call-three-phases.zh.md)让工具身份在 `tool/call` 之前就可见。只有原始参数前缀不足以按字段展示：write/edit 需要完整路径和解码后的内容长度，bash/run_code 需要在命令或程序流入结束前显示描述。

模型生成参数的顺序也决定了什么能先显示。2026-09-24 用真实 DeepSeek V4 API 对 bash/run_code/write/edit 做了 310 次受控请求：

| 变体 | 改了什么 | bash 首键为 description | run_code 首键为 description |
|---|---|---|---|
| 现状 | — | 0/20 | 1/20 |
| 只调 `properties` 顺序 | description 提前 | 0/20 | 0/20 |
| `properties` + `required` 同调 | 同上并调 `required` | 强制 tool_choice 10/10；自由调用 pro 7/10、flash 0/10 | 强制 10/10；自由 20/20 |
| 同调 + 描述文本加一句顺序指令 | 追加「Provide `description` before `command` in the arguments.」 | 自由调用 flash 19/20、pro 20/20 | 20/20 |

在这些样本中，单调 `properties` 无效时，调整 `required` 能改变参数顺序；V4 Flash 自由调用 bash 还需要显式指令。`dsh-tools` 的 schema DSL 按属性声明顺序生成 `required`，所以改源码声明顺序会同时调整两者。探针使用极简系统提示词，不是完整 Harness 提示词。

## 决策

### 懒计算的参数视图住在 `dsh-util-values`

`PartialArguments` 是一个不认识任何工具的懒计算类。它持有原始文本（preparing 期是累积的 delta；`tool/call` 后直接包着事件里的字符串；PTC 子调用包着事件里的对象）和一份一级索引，任何读器（`has`、`complete`、`stringLength`、`text`、`value`、`keys`）被调用时才从上次消费的位置继续扫到末尾；没人读就一个字符都不扫。原文按需从原始文本切出解码，所以不需要"哪些字段保留文本"的规格，也不需要注册表。

变化由视图自己判定：它记住每个被问过的问题及其答案，`append(delta)` 只重算这些问题，某个答案变了才返回 true；没人读过就永远 false。业务在读的时候说明粒度——`stringLength('content', { step: 1024 })` 让跨 KB 才算变化，`text('description')` 让每个字符都算变化。edit 进度合计新旧文本时，`offset` 计入已完成的字符串。

### 解析在 Tool Definition 层，不在 React

[Tool Definition](../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts) 把每个带 id 的 `tool-call-delta` 都匹配为 start 候选：最早的一个打开 Context（无论是否带名），后续折叠为 update。带名 delta 创建 preparing 根并挂上一个新的流式视图；每个 delta 只做 `args.append(delta)`，视图报告变化时才换根块引用。发布节奏沿用 `animation-frame`。参数在名字之前到达的流不扫描：迟开的视图看到非对象前缀即 invalid、零字段。

三个阶段的块都提供 `name` 和 `args`，原有 `argsRaw` 和 result 的 `call: { name, argsRaw } | null` 仍可使用。已派发根调用使用 `PartialArguments.fromText(argsRaw)`，PTC 子调用使用 `fromObject(payload)` 而不 stringify，结果复用已派发视图。未配对的根结果使用空名称和共享空视图。卡片模型继续读取 `argsRaw`。

工具行在各阶段使用相同读器：read/write/edit 在 `file_path` 闭合后显示可打开的路径；write/edit 在内容流入时按 1024 字符单位显示解码后长度；bash/pwsh/run_code 显示描述前缀。Chat 分组详情按既有字段优先级读取同一视图。没有可用详情时，只要字段还可能到达就留空；`closed()` 为真后才回退工具名，所有类别一致。

三方工具无需注册或独立订阅就能取得同一视图。write/edit 和 Bash 在各阶段共用组件。可变参数读器是 owner 数据要求 JSON 兼容的一项限定例外：已读取答案变化时，所属 Definition 发布新的块引用。扫描缓存使用私有字段，同源视图的结构比较不受读取历史影响。

### 参数声明顺序

`tool-bash`、`tool-pwsh` 在 `command` 前声明 `description`，并包含顺序指令；`run_code` 两处 `parameters` 将 `description` 放在 `code` 前，不加指令。write/edit/read 的 `file_path` 已在首位。其他工具保留原有参数顺序。

## 考虑过的替代方案

**在 hook 闭包里解析（选择器订阅 Step source）。** 只有订阅行能看到解析结果，分组标题需要另一份订阅，每行还要负责解析器生命周期。Definition 持有的视图让消费方共享已解析字段。

**在 Definition 里维护每工具字段规格（内建表 + 运行时注册表）。** Definition 是纯函数、拿不到 ctx，运行时注册表只能经工厂闭包注入，三方工具要在坑位与注册表两处登记；而规格表本质只是"哪些字段保留文本"，懒计算按需从原始文本切出原文后这条信息不再需要。

**第三方 `partial-json`。** 每帧重解析累计输入，且不独立于解码值暴露字符串完成状态。

**提前解析所有字段。** `content` 等大字段通常只需要长度；在消费方请求前构造全文，会增加解码和内存成本。

**只调 `properties` 顺序。** 实测 0/40 生效；模型跟随 `required` 顺序。

## 验证

- 解析器测试覆盖懒扫描、已读取答案变化、空键与重复键、跨片转义、非字符串值、非法输入、封存视图，以及不受读取历史影响的结构相等。
- 工具行和分组测试覆盖流式路径与描述、内容长度、共用行身份，以及参数不再增长后才回退工具名。

## 影响

- 已读取参数变化时替换准备态块，无人读取的调用保留块引用。视图保留源文本，分组标题可以独立于工具行请求字段。已派发和已结算视图在首次读取时扫描，不发布更新。
- 模型顺序是概率行为：调序与描述指令把 description 先到的比例提到约 100%，但不是契约；行的显示逻辑按「哪个字段先闭合先显示哪个」设计，顺序反转时只是收益消失。
- 展示仍由 Client 派生；参数扫描不新增 Session 事件或持久化格式。
- 名字晚于参数到达的流放弃扫描，该调用的准备行退回只显示标题。
