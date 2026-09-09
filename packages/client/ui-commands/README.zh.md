---
description: "Web GUI 的客户端命令 API：/ 命令 source、三类派发、会话级命令目录，以及面向业务包的 popupSelect 与 action 注册；供斜杠命令的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-commands

[English](README.md) | 中文

## 概述

键入 `/` 命令会打开已注册的弹窗、运行客户端动作、进入宿主命令的输入或直接执行，命令行不会被静默降级为普通提示词。业务包通过 `ctx.commandUi` 注册 popupSelect（`/model`、`/permission`）或 action，也可用这两种方式装饰既有宿主命令，同时保留其目录行与参数声明。空格与回车根据会话目录解析命令行：带 `input` 的宿主描述符是 `leadingInput`，注册了 `CommandUiSpec` 的是 `popupSelect` 或 `action`，其余是 `execute`。

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

与 `ui-input-trigger` 及 `ui-conversation` 一起挂载本插件；`/` source 随即出现在触发菜单中，业务包经 `ctx.commandUi` 注册自己的命令表面。键入 `/model` 打开已注册的弹窗；带参数声明的宿主命令打开其输入或直接执行。composer 的 `+` 按钮与键入的 `/` 打开同一个菜单：「添加」小节（文件、目标、计划、反馈）与「指令」小节（压缩、权限、模型、下载日志）按使用频次排列，每行带图标、本地化的标题与说明，本地化标题与命令名不同时还显示命令名作为别名。

### 种类与装饰

贡献项是客户端自有命令——与宿主命令同名会明确报错。它的 UI 是 popupSelect 规格或动作：裸调用在消费掉触发 token 之后运行的一个回调，它不提交任何内容，因此绝不会拒绝带附件的草稿。菜单里的「文件」行就是本包自己的动作；只要 composer 接受文件，它就经会话作用域的 `slash/input-pick-files` 事件打开 composer 的文件选择器，子智能体上不提供。装饰为**已存在的**宿主命令添加裸调用弹窗或动作：宿主命令保留其目录行、参数声明与生命周期记账，被装饰的名字在会话目录中无宿主行时永不触发。菜单查询按顺序且不区分大小写地模糊匹配命令名与标题的子序列；前缀排名最高，输入查询后匹配项平铺列出，不再带小节标题。

### 内置行的展示面

宿主描述符只携带英文文案，因此 `src/client/presentation.ts` 拥有六个内置宿主命令在客户端的展示面：目录行的说明与规范英文文案相同时，它从 `command` 词典取得本地化的标题、说明、图标与声明 token；同名的作用域覆盖或第三方命令保留自己的说明，只有小节位置跟随名字；不在两个小节清单里的行按目录顺序排在「指令」小节末尾。中文下选中「计划」会在 composer 填入 `/计划 `，提交仍执行 `/plan `；键入的 `/计划` 或 `/目标` 在任何语言下的空格与回车裁决中都同样解析，因此在一种语言下写的草稿在另一种语言下照样能提交。贡献项自带 `label`、`description` 与 `icon`，每次生成候选项时读取，语言切换后下一次打开菜单即生效，无需重新注册。

### 带附件提交

composer 携带图片或通用文件提交时，只有声明了 `input.attachments` 的宿主命令继续。其余命令路径都会抛出本地化的 `attachmentsUnsupported` 拒绝，以瞬态 toast 呈现，草稿与附件卡保持原位。处理器返回错误时保留相同草稿状态供用户重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`src/client/contract.ts` 是固定的业务约定：`CommandUiContract.register(name, spec)` 与 `decorate(name, spec)` 是业务包消费的全部内容。`CommandDirectory` 是唯一的 wire 派生缓存，以会话为 key：普通会话经 `command.list({sessionId})` 拉取；条目由转发的 `commands/change` owner 事件软失效、由 `connection/reset` 硬失效，并以 epoch 把关，被取代的旧拉取永远无法覆盖更新的结果。`matchSpace` 只凭该缓存同步应答；`matchEnter` 在 SubmitAttempt 信号上强等缓存，预热失败即拒绝。`command.execute` 返回匹配结果后，浏览器发布本地 `command/executed` 确认；其他客户端经宿主事件流收到持久命令节点，但收不到这条确认。`PopupSelectController` 是不含界面的外壳状态；`PopupSelectView` 自注册进 `conversation.input.overlay`，按会话解析。`presentation.ts` 持有小节清单、内置行的展示面与本地化 token 的解析；`candidates` 对空查询分小节、对输入的查询经共享的 `rankByName` 排序。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当命令面不够用时阅读以下页面。它们从命令 API 进入触发流水线与宿主命令注册表。

- [ui-input-trigger](../ui-input-trigger/README.zh.md)——`/` source 注册进的流水线。
- [ui-conversation](../ui-conversation/README.zh.md)——声明输入浮层槽位并拥有 composer。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由派发路径触发的宿主 `command.execute` RPC：每个命令 handler 的宿主包拥有任何模型可见效果（`/plan` 的 handler 翻转 plan 模式，其归属包注入 policy 段），而命令行、分离结果与所有菜单和 notice 渲染都留在客户端，永不进入会话日志。

#### KV Cache 影响

无直接影响；该包既不组装也不发送提供方请求。它触发的命令 handler 可能改变归属宿主包对下一个请求系统提示词的贡献——某个 section 的出现或消失会替换较早的请求 token，并使提供方前缀从该点起失效——但这一影响由各命令的宿主包拥有并记录。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前命令表面。它们是当前包约束，不是通用命令行对比或任务积压。

- **脱离会话后，分离结果 notice 回退到 console**——fire-and-forget 路径经 `SessionInput.notify` 把结果送到触发会话的 composer；会话销毁后，console 输出行是仅剩的呈现面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是基于 wire command directory 的浏览器侧 source，不发出 Cordis 事件，也不持有跨插件可变状态；dispatch 与 cache 行为由包测试覆盖。
