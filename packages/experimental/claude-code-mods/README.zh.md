---
description: "实验性桥接：加载 Claude Code 模组（hooks module），把它们的钩子链运行在 harness 扩展点上，供挂载模组的用户与扩展映射的维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-claude-code-mods

[English](README.md) | 中文

## 概述

在 agent（智能体）运行中运行 [Claude Code 模组（mod）](https://code.claude.com/docs/en/plugins/mods/overview)：把 `pluginDirs` 指向模组目录，它们的 `register(on, options)` 钩子就能通过同一条 `$`、`e`、`next` 链守护工具调用、改写提示词、添加命令与工具并读取会话事实。在模组行动之前挂载没有成本；每个 `$` 调用都基于一个已组合的 harness 服务。需要原样试用现有模组时选择本包；它是 alpha 质量的接口兼容性演示，未提供的事件与 `$` 成员会以指明缺口的消息失败，也不会在 GUI 中绘制任何内容。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载本包并给出要加载的插件目录，用法与 `claude --plugin-dir` 相同。每个目录包含 `.claude-plugin/plugin.json` 以及恰好有一个 `modules` 条目的 `hooks/hooks.json`。

```yaml
- name: '@deepseek-ai/dsh-experimental-claude-code-mods'
  config:
    pluginDirs:
      - ./mods/token-weather
      - ./mods/blast-radius
    options:
      token-weather:
        history: 12
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pluginDirs` | 必填 | 按链顺序排列的插件目录；相对路径相对于进程启动 cwd 解析 |
| `options` | — | 按插件名给出的 `register` 选项值，叠加在 manifest（元数据清单）的 `userConfig` 默认值之上 |
| `hookTimeoutMs` | `10000` | 一个钩子每个事件的自身运行时间（Claude Code 的限制）；在 `next` 或 `$` 调用内的时间不计 |
| `catchTimeoutMs` | `1000` | `.catch` 处理器的运行时间 |
| `processTimeoutMs` | `30000` | `$.process.run` 与 `$.http.fetch` 的默认超时 |
| `toolAliases` | — | 追加到内置表的「Claude Code 工具名 → harness 工具名」条目 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-claude-code-mods)是每个可接受字段的权威来源。

### 你的模组会收到哪些事件

| 事件 | 触发自 | 钩子可以 |
|---|---|---|
| `session.start` | 根 agent 的 `agent/created`，在其第一个轮次前等待完成；取消创建会放弃仍在等待的钩子 | 观察；注册命令与工具 |
| `prompt.submit` | 带有已认领消息的 `agent/pre-step`；`e.text` 拼接的是用户自己（来源为 `user`）消息的文本块，改写也只触及这些消息 | 改写 `text`、添加模型在提示词之后读取的 `context`，或用 `{ drop }` 丢弃提示词 |
| `turn.start` | 一个轮次的第一个 `agent/pre-step` | 观察 |
| `tool.call` | `tools/execute` waterfall（瀑布式事件），在 harness 权限决策之后；模组通过 `$.tool.call` 发起的调用只到达更早加载的模组，并归因于调用方 | 在前后观察、`{ deny }`、用 `{ result }` 应答，或在 `next` 之后改写结果或其 `isError` |
| `turn.complete` | `turn/end` 会话事件 | 观察；返回 `{ text }` 在 host 日志中写一行 |
| `command.run` | 用户输入了模组通过 `$.command.register` 注册的命令 | 用 `{ text }` 或 `{}` 应答 |
| `session.end` | 根 agent 的 `agent/disposed`；`$.state` 在钩子结算前仍可读取 | 观察 |
| `<namespace>.<method>` | 更晚加载的模组的 `$` 调用（`tool.call` 改经工具流水线到达） | 观察、改写或 `{ deny }` 该调用 |

harness 工具若有 Claude Code 对应名称，`e.tool` 与 `tool` matcher 使用 Claude Code 的名称（`Bash` ↔ `bash`、`Read` ↔ `read`、`Edit` ↔ `edit`、`Write` ↔ `write`、`Glob` ↔ `glob`、`Grep` ↔ `grep`、`WebFetch` ↔ `web_fetch`、`WebSearch` ↔ `web_search`、`Task` ↔ `subagent`、`TodoWrite` ↔ `todo_write`、`AskUserQuestion` ↔ `ask_user_question`、`ExitPlanMode` ↔ `exit_plan_mode`、`Skill` ↔ `skill`）；其余工具保持 harness 名称。subagent 事件携带 `e.agentId`。其他每个 Claude Code 事件名都能无错注册，但永远不会触发。

### 你的模组能调用哪些 `$` 成员

| 命名空间 | 已提供 | 基于 |
|---|---|---|
| `$.plugin` | `name`、`root` | manifest |
| `$.ui` | `log`、`toast`、`status`、`invalidate`、`open`、`close`、`panes`、`ask` | `ask` 基于 `ctx.userQuestions`；其余写入 host 日志，`open` 应答 `{ isPlaced: false }` |
| `$.command` | `register`、`run`、`list` | `ctx.commands`，作用域为事件所属的 agent |
| `$.tool` | `register`、`call`、`list` | `ctx.tools`；注册的工具命名为 `mcp__<plugin>__<tool>` |
| `$.prompt` | `submit` | `agent.followup()`，除非 `asUser`，否则框定为来自模组的消息 |
| `$.session` | `id`、`cwd`、`root`、`model`、`turns`、`messages`、`usage`、`version` | agent 的 Session 以及 `turnBoundary` 与 `contextPressure` 投影；`cwd` 与 `root` 都报告会话工作区，harness 每个会话只有一个目录 |
| `$.state` | `get`、`set` | 为该会话保留的内存，按模组给出的 `{ plugin, key }` 寻址 |
| `$.store` | `get`、`set`、`delete`、`keys` | `claude_code_mods` storage domain，每个插件一个 JSON 对象，上限 4 MiB |
| `$.clock` | `now`、`sleep`、`after`、`every` | 桥接在卸载时取消的定时器 |
| `$.fs` | `read`、`write`、`list`、`exists`、`stat` | `ctx.fs`，相对会话工作区解析，单文件上限 4 MiB |
| `$.process` | `run` | `ctx.subprocess`，argv 不经 shell |
| `$.http` | `fetch` | 本进程的 `fetch`，响应体上限 4 MiB |
| `$.env` | `get`、`set` | 本进程的环境变量，由所有会话与插件共享 |

所需服务未组合时，调用会以缺失服务的包名拒绝；表外的命名空间或方法以 `no implementation for <namespace>.<method>` 拒绝。

### 测试模组

`createModTestKit` 从目录或内联模块加载模组，并以 `claude-code/testing` 的形态在它们之下放置 stub 后触发事件：`kit.on('tool.call', () => ({ result: 'ok' }))` 代替引擎应答，`kit.$.tool.call({ tool: 'Bash', command: 'ls' })` 触发事件，`mock.store(kit.on)` 用内存应答 `$.store`。[测试工具包 spec](tests/testing.spec.ts) 对 fixture（测试前置数据）模组原样运行 Claude Code 自己的 `first-mod` 教程测试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 加载

[`manifest.ts`](src/manifest.ts) 读取并校验 `plugin.json` 与 `hooks.json`；无法按模组解读的目录会使插件加载失败，因为那是部署错误。[`module.ts`](src/module.ts) 通过 Node 导入 hooks module，并附带每次加载唯一的 query，使重新加载重新求值模块；随后运行 `register`，把每个 `on(...)` 收集进 `HookRegistry`；`on` 以 Claude Code 的措辞拒绝未知事件名以及同一事件第二次无 matcher 的注册。导入失败或 `register` 抛错的模块会被跳过并给出警告，会话照常继续，与 Claude Code 一致。

### 链

[`chain.ts`](src/chain.ts) 让一个事件依次经过选中的钩子（最外层在前），底部是引擎行为。每个钩子的 `next` 委托给下层；抛错、超时或未以结果对象结束的钩子会被跳过，并按失败种类各报告一次；若它已经调用过 `next`，下层的结果保持有效；`.catch` 处理器可以代替它应答。预算时钟只计钩子自身的运行时间：在 `next` 内以及除 `$.clock.sleep` 外的每个 `$` 调用内暂停。[`engine.ts`](src/engine.ts) 拥有注册表、按会话的 `$.state`、模组定时器以及两个派发方向：引擎事件到达每个选中的钩子，而某个模组发起的 `$` 调用只到达在它之前加载的模组。

### 映射到 harness

[`index.ts`](src/index.ts) 注册监听器。`tool.call` 围绕 `tools/execute` 运行，因此 harness 权限决策先于这条链；`{ deny }` 变成带原因的错误结果，模组注册工具的 `{ result }` 变成成功的内容结果，而内置工具的 `{ result }` 变成错误形态的结果，因为内置工具的成功值必须满足它自己的输出 schema。钩子在 `next` 之后改写的结果通过 `tools/post-execute` 作为替换内容安装。[`host-ops.ts`](src/host-ops.ts) 持有每个 `$` 调用基于 `ctx.get(...)` 服务的引擎行为，因此部署只需组合其模组实际使用的服务。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、模组加载、扩展点监听器 |
| [`src/host-ops.ts`](src/host-ops.ts) | 基于 harness 服务的 `$` 行为 |
| [`src/engine.ts`](src/engine.ts) | 注册表、`$.state`、定时器、派发方向 |
| [`src/chain.ts`](src/chain.ts) | middleware 链、预算时钟、失败规则 |
| [`src/api.ts`](src/api.ts) | 钩子收到的 `$` 对象 |
| [`src/module.ts`](src/module.ts)、[`src/manifest.ts`](src/manifest.ts) | hooks module 导入与 `on`；插件目录校验 |
| [`src/matcher.ts`](src/matcher.ts)、[`src/tool-names.ts`](src/tool-names.ts) | 事件名、matcher、工具名别名 |
| [`src/testing.ts`](src/testing.ts) | 测试工具包 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Claude Code 模组参考](https://code.claude.com/docs/en/plugins/mods/reference)——本桥接所镜像的事件、方法与限制。
- [实验性包](../README.zh.md)——发布策略与依赖隔离。
- [hooks 组](../../hooks/README.zh.md)——settings 钩子桥接；同时包含 settings 钩子的 `hooks.json` 需要 `dsh-hooks-claude-code` 来运行它们。
- [工具执行流水线](../../../docs/tool-execution-pipeline.zh.md)——`tool.call` 所围绕的 waterfall。
- [人类命令](../../interaction/commands/README.zh.md)——`$.command.register` 落在的注册表。

-----

<a id="model-experience"></a>
## 模型体验

### 提示词上下文与提交的提示词

#### 模型看到什么

`prompt.submit` 钩子加入 `e.context` 的字符串会作为一条来源为 `{ kind: 'claude-code-mods' }` 的 user 消息跟在提示词之后到达；改写的 `text` 会替换提示词的文本块。`$.prompt.submit({ text })` 入队一条同样来源的 user 消息：带 `asUser: true` 时只有该文本，否则按下文框定，填入插件名与该文本。

##### 模组提交的提示词的框定

```markdown
Message from the "<plugin>" mod:
<text>
```

#### Token 影响

在模组添加上下文或提交提示词之前无成本；这些文本依赖数据、会被记录，并在后续请求中重复发送直至上下文压缩。

#### KV Cache 影响

仅追加：添加的上下文与提交的提示词跟在可复用请求前缀之后，不会使已有条目失效。

### 模组决定的工具结果

#### 模型看到什么

`{ deny: reason }` 应答把 `Error: <reason>` 渲染为工具结果。对模组注册的工具，`{ result }` 应答把文本渲染为成功结果；对内置工具则渲染为错误形态的结果。在 `next` 之后改写的结果替换工具的内容文本。被丢弃的提示词以 `blocked` 结束轮次，没有模型可见的消息。

#### Token 影响

拒绝与应答的调用用模组的文本替换工具自身的输出；被丢弃的提示词不发送请求。

#### KV Cache 影响

工具结果追加在可复用前缀之后；被丢弃的提示词不会使任何内容失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述 Claude Code 模组经由本桥接时行为不同之处。它们是当前包约束，而非任务积压。

- **没有绘制表面**——`ui.render`、`ui.press`、`ui.input`、`ui.select`、`ui.resolve`、面板、提示框上方的横带以及元素树均未提供：`ui.render` 钩子永不运行，`$.ui.open` 应答 `{ isPlaced: false }`，`$.ui.log`、`$.ui.toast` 与 `$.ui.status` 写入 host 日志而非 transcript（文本记录）。可以承载它们的 Web GUI slot（横带对应 `conversation.input.dock`，toast 对应 `shell.overlay`，状态对应 `conversation.composer.dock`，日志行对应一个仅记录的会话事件加 Chat 节点）已经存在，但尚无客户端插件渲染模组树。
- **未提供的事件**——`tool.check`、`tool.describe`、`turn.step`、其余 `prompt.*` 事件、`command.describe`、`config.*`、`session.compact`、`session.receive`、`session.send`、`session.append`、`session.attach`、`session.detach`、`session.measure`、`agent.*`、`plugin.register`、`engine.create` 与 `telemetry.*` 可以注册但永不触发；`classic.*` 名称与其他未知事件一样在 `register` 时被拒绝。
- **未提供的 `$` 命名空间**——`$.model`、`$.agent`、`$.config`、`$.settings`、`$.mcp`、`$.audio`、`$.telemetry`、`$.turn`、`$.ui.notice`、`$.ui.blit`、`$.ui.copy`、`$.fs.ancestors`、`$.process.spawn`，以及 `$.session.repo`、`send`、`append`、`authorize`、`compact`、`surfaces` 以 `no implementation` 拒绝。`$.model.complete` 等待一个记录副请求的会话事件，使模组的模型调用仍可从会话日志重建。
- **`tool.call` 在权限决策之后运行**——Claude Code 在其权限检查之前运行模组的 `tool.call` 钩子；这里 harness 的 `tools/pre-execute` waterfall（包括审批）先行落定。传给 `next` 的参数改写不被采纳，因为调用参数已被记录；桥接按工具各警告一次。
- **代替内置工具应答**——代替内置工具运行的 `{ result }` 以携带该文本的错误形态结果到达模型，因为成功值必须满足该工具的输出 schema。
- **一个进程，多个会话**——模组的模块级变量与 `$.env.set` 的写入由进程内的所有会话与插件共享，而 Claude Code 每个进程只运行一个会话；按会话的值请放在 `$.state`。`session.start` 与 `session.end` 只为根 agent 触发。
- **没有沙箱、静态分析与热重载**——hooks module 在进程内以 Node 全局对象运行；仅经 `$` 访问的规则、`claude plugin validate`、类型生成、`--plugin-dir` 监视以及会话内模组编写流程均未实现。模组的 `.ts` 模块只在 Node 剥离类型或启动器转译时才能加载。
- **`turn.complete` 文本**——钩子返回的 `{ text }` 写入 host 日志，而非答案下方的一行；`durationMs` 从该轮次的 `turn/start` 起计。
- **`$.session.usage`**——在路由的上下文窗口与 provider 用量报告经 token meter 可知之前，`window` 为 `0` 且没有 `percent`；`rateLimits` 始终为空。`$.fs.stat` 报告 `mtimeMs: 0`。
- **`hooks.json` 中的 settings 钩子**——忽略并给出警告；请为它们挂载 `@deepseek-ai/dsh-hooks-claude-code`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

按对模组作者的价值排序，下一步是：为 `$.ui.log` 行提供 `claude-code-mods/ui` 会话事件与 Client Chat 节点；在 `conversation.input.dock` 上为 `Box`/`Text`/`Button` 树提供 `AbovePrompt` 渲染器；基于 `ctx.llm` 并带记录请求事件地提供 `$.model.complete`。

</details>
