---
description: "子级作用域 report 工具，供用户与维护者组合或排查可继续 subagent 的子到父返回通道。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-report

[English](README.md) | 中文

## 概述

`dsh-tool-subagent-report` 为每个可继续的进程内 child 提供一个临时的 child 作用域适配器，连接相邻 Agent 消息服务：它安装 `report` 工具及指示 child 使用该工具的提示词指导。根 Agent、一次性 subagent、远程提供方与 sibling 作用域永远看不到这两个注册项。被接受的报告通过固定 Steer 调度到达直接 parent，并与 parent 到 child 的消息使用相同前缀和来源信息。可继续模式不依赖本包，也不依赖控制包。

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

在包含可继续进程内子级、且父级应在子级结束前看到其发现的组合中挂载本包。工具及其指导会自动出现在每个可继续子级内部；无需任何按子级的配置。

### 最小配置

先加载 subagent 服务、一个后端、处于 `continuable` 模式的委派工具与本包：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    backgroundMode: continuable
- name: '@deepseek-ai/dsh-tool-subagent-report'
```

本包不接收任何配置。

### 子级获得什么

每个可继续子级都会获得一个 `report` 工具，其唯一参数是 `output`——给父级的自足答案——以及一段提示词 section，指示子级在结束前调用一次 `report`，并在部分发现会改变父级下一步动作时提前调用。该指令是引导而非强制：一个轮次内子级可以调用零次或多次，结束轮次也绝不会自动上报。调用成功既不会结束轮次，也不会结算子级的 Activation。

### 父级看到什么

被接受的报告会成为一条用户角色的 parent 消息，以 `Agent <child-id> sent a message:` 开头，后接 child 未经改动的输出，并带有指明 child 的持久化 `agent-message` 来源。固定 Steer 调度会为空闲 parent 启动一个轮次，或加入运行中 parent 最近的 step 边界。工具不接受接收方参数：它根据 child 持久化的 `parentSession` 推导唯一接收方，并把授权与投递交给 `ctx.subagents.sendMessage()`。

### 作用域与方向

`report` 工具有意不受子级全局 `toolFilter` 影响：委派允许列表无法移除唯一的返回通道。要求子级不具备返回通道的部署应省略本包。父到子方向仍由独立安装的控制包负责，可继续模式不依赖这两个包中的任一个。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具的安装与调度方式；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

本包注册的是可继续子级设置贡献，而非全局工具，因此工具及其指导安装于每个子级未发布的作用域内部，并随其一同消失。这些注册都是普通的子级作用域贡献，因此专家级 `system-prompt/assemble` 监听器可以替换它们，替换后则由其负责为该子级保留上报协议。

### 投递调度

服务始终使用 `parent.steer()`：运行中的 parent 在最近的 step 边界接收报告，空闲 parent 启动一个轮次，按顺序接受的报告共享 next-step FIFO。面向模型的 schema 不能选择或覆盖调度方式。

### 导出的贡献

`installReportTool(childCtx, ctx)` 把工具及其指导安装到新创建的 child 作用域中，并返回同时撤销两者的唯一 disposer。生成工具目录使用这条路径，因为全局注册表无法公开作用域局部 schema；生产组合仍通过 `apply()` 进入。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 可继续 child 设置与 `installReportTool` 适配器 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从上报通道进入其背后的继续执行服务与面向父级的工具。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——可继续 child、Activation 与 `sendMessage` 约定。
- [dsh-tool-subagent-control](../tool-subagent-control/README.zh.md)——父到子的控制工具。
- [dsh-tool-subagent](../tool-subagent/README.zh.md)——启动可继续子级的委派工具。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-report)——`report` 的 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

已生成的 [`report` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-report)：一个必填 `output` 字符串。其描述说明子级必须在结束前上报一次，上报只会到达启动该子级的 Agent，并且不会结束轮次。它不包含接收方或投递模式参数。独立的 `tool:report` 提示词 section 在 schema 之外重申该义务。

#### Token 影响

每个可继续子级请求支付固定的 schema 与提示词 section 成本，其他任何 Agent 的请求均无此成本。

#### KV Cache 影响

子级中的前缀保持稳定；schema 与该 section 都不会在运行时改变。移除本包会从驻留子级中撤销两者，从而改变其下一次请求前缀。

### 上报结果

#### 模型看到什么

接受时返回 `report accepted by the agent that started you as message <messageId>`；规范输出携带稳定的 `messageId`。sender 未授权、parent 不可用或生命周期正在关闭时，会返回出错结果。投递接受之后仍可能运行后续工具结果 hook，它们不归本包所有。

#### Token 影响

每次调用都会在执行上报的 child 中产生一条简短确认消息。parent 还会为上报内容支付 token 成本：投递会加入 parent 已打开轮次的下一次请求，或为空闲 parent 启动一个轮次。

#### KV Cache 影响

在子级中仅追加。在父级中，带前缀的报告位于现有历史之后，并保留可复用前缀。

### 父级可见的报告

#### 模型看到什么

一条用户角色的 parent 消息，以 `Agent <child-id> sent a message:` 开头，后接 child 未经改动的 `output`，并带有指明该 child 的持久化来源 `{ kind: 'agent-message', form: 'relay', senderSessionId: <child-id> }`。

#### Token 影响

子级的完整 `output` 加上一行前缀；本包不设上限。

#### KV Cache 影响

仅追加；报告位于 parent 可复用请求前缀之后。Steer 会唤醒空闲 parent，并可能延长已打开的轮次。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明被接受的报告保证什么、不保证什么；它们是当前包约束。

- **父级可能在宿主启动 dispose 后继续接受报告**——`AgentHandle.dispose()` 会先取消并等待完全停稳，然后才撤销作用域并离开注册表；它不公开「dispose 已开始」信号。在该窗口内接受的报告会追加到父级 transcript（文本记录），但该父级不会在本进程中处理它。对于由继续执行管理器拥有的父级，管理器的准入边界会在整片森林拆卸期间拒绝该上报。
- **接受弱于持久投递**——没有持久化 mailbox、幂等键、投递回执、重试协议，也不保证恰好一次。任一侧记录接受后若进程失败，结果都不明确；外部重试可能产生重复上报。
- **授权须等到下一个 Activation，撤销则立即生效**——子级驻留后再安装本包，只会在该子级的下一个 Activation 中授予 `report` 及其指导；移除本包则会立即从驻留子级撤销两者。
- **嵌套上报只向上到达一条直接边**——孙级只向作为其直接父级的子级上报，不会直接到达顶层协调器；该直接父级必须随后显式发出一条衍生更新。
- **没有速率限制**——嵌套 child 频繁上报会放大模型工作量，但一起等待的报告会共享一个 step。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
