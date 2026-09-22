---
description: "使用并排查实验性 Web Agent Teams roster、共享任务板与 teammate 导航面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

[English](README.md) | 中文

## 概述

本包向 Web 会话页头添加 Agent Teams action，让用户检查当前 roster、查看共享任务板并导航到 teammate 会话。它从共享 Session store 读取 Lead Session 的 `agentTeam` 投影，Host 投影 frame 使其保持最新而无需刷新控件，并让普通 child history 导航继续使用稳定的 addressed-subagent 路径。通过公开发布的实验性 Agent Teams bundle 选择本包。这个浏览器 projection 不扩展稳定 API Proxy、不存储 Team 状态，也不注册面向模型的输入。

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

通过 [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.zh.md) 启用本包。这个组合包同时提供团队服务、工具与 Web 界面。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 检查并导航 roster

触发按钮显示 teammate 数量，panel 显示 Lead Session `agentTeam` 投影中的 roster 与任务板，因此 agent 创建的任务或进入 `active` 的 teammate 会在 panel 打开期间直接出现。无论在 Lead 会话还是 teammate 会话中，打开 panel 时都按每次连接一次的规则请求 Lead 的投影基线。之前读取成功则复用；读取失败会在最后有效 Team 旁显示重试控件，重连后会重新加载。读取成功但缺少 Team 能力时显示不可用提示。panel 还会请求当前 Session 与 Lead 之外 active 成员的投影基线，包括尚未打开的持久 Session，并在新成员进入 active 时加载它。Roster row 展示持久 name 与状态：`failed` 与 `provisioning` 来自持久成员 phase，`running` 或 `inactive` 来自成员 Session 的实时状态。当成员 Session 的 `modelSelection` 投影记录了持久选择或请求时显示 model。provisioning 和 running 成员使用共享 ongoing loading，inactive 成员使用 idle 灰点，failed 成员使用 error 红点。选择健康 teammate 时，系统直接根据其 Lead 与 roster 身份打开普通的 `{ parentSessionId, childSessionId, mode: 'continuable' }` address，不刷新或检查 parent catalog。Host 在打开历史时校验 parent、child 与 mode。History 与后续人类提示词继续使用稳定 addressed-subagent 会话路径；本包不会添加 Team 专用 address 字段。

### 查看任务板

可开始的 pending 任务使用 idle 灰点，被依赖阻塞的 pending 任务使用 warning 橙点，in-progress 任务使用 ongoing loading，completed 任务使用 done 绿点。

只读任务板展示任务标识、负责人、依赖、就绪状态、提示性写入范围与重叠警告。Team agent 通过工具创建和更新任务；面板不提供任务修改控件。当投影报告某条持久 Team 记录被拒绝时，面板在最后有效的 roster 与任务上方显示该失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 通过 Cordis effect 注册 locale dictionary 与一个 conversation-header slot；它不挂载任何 Remote namespace。Dispose plugin fiber 会移除这两项 registration。

面板渲染在会话容器外，并保持在视口范围内。打开时焦点移入面板；按 Escape 或选择关闭按钮时，焦点返回触发按钮。点击外部或将焦点移出面板与触发按钮时，面板关闭，但不会将焦点移回。组件通过 `useProjection('agentTeam')` 读取当前 Session 的 Team，通过 `useProjection('modelSelection')` 读取其 model。在 teammate 会话中，`useSession` 提供 Lead 身份，`useSessions` 读取其 Team 值。两类会话均通过独立的 `useSessions` selector 读取 Lead 的基线读取状态和错误。每个 roster row 只选择自己的 model 和运行状态；panel 不订阅完整投影集合，也不订阅完整摘要或状态集合。它仅有的注入回调是读取 Session 的投影基线与打开 teammate。切换会话会关闭面板并清除导航失败。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | locale、投影读取、导航与 slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | 由投影派生的 roster 与任务板及面板交互状态 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文 panel 文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Teams bundle](../agent-team-profile/README.zh.md)——挂载本 Client plugin 的公开 opt-in bundle。
- [Agent Teams service](../agent-team/README.zh.md)——权威 roster、task 与投影行为。
- [会话 UI](../../client/ui-conversation/README.zh.md)——稳定 header slot 与 addressed-subagent 导航表层。
- [实验性包](../README.zh.md)——孵化状态与发布规则。

-----

<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器 projection 不注册面向模型的输入。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **能力缺失的缓存** — 如果其他 UI 在启用 Agent Teams 前已读取 Lead 的投影基线，打开本面板会复用该基线；重新连接后才能加载新启用的能力。
- **成员基线读取失败** — 面板只显示 Lead 的读取错误。其他 active 成员的读取失败会在重新打开面板或收到 roster、任务更新时重试；Team 活跃期间，持续失败可能反复发出请求。
- **没有 mailbox timeline**——投影视图只承载 roster 与任务；不显示 peer 消息。
- **首次请求前的模型** — 没有持久模型选择或请求的成员不显示模型。未运行的持久成员可通过显式投影读取提供模型；实时活动仍需要正在运行的 Host agent。
- **普通 child continuation**——导航后发送的人类消息使用稳定 addressed-subagent 提示词路径，而不是 Team peer mailbox。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Host 投影是权威来源，本包只持有一个可释放的 slot 注册。
