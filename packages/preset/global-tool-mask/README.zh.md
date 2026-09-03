---
description: "面向单个 agent preset 的、由组合书写的全局工具掩码：一行把点名的宿主工具对该 preset 组合出的会话隐藏起来。"
kind: "package-reference"
---

# @deepseek-ai/dsh-global-tool-mask

[English](README.md) | 中文

## 概述

`dsh-global-tool-mask` 是写成组合行的 `tools.restrict()`。宿主的全局工具——由宿主行注册的那些，如 `web_fetch`——经全局层到达每一个会话，而在此之前 preset 文件里没有任何东西能藏起其中一个：preset 能加行，却减不掉别的行注册的工具。挂在 agent preset 内部时，本行只对该 preset 组合出的会话遮蔽点名的全局工具，别的一概不动；挂在全局则拒绝，因为一个上下文全局的限制会遮住每一个 agent。它预期的落点是 preset 的用户补丁层（`$DSH_HOME/.agent-presets/<id>/cordis.patch.yml`）：一个人不必编辑部署随附的组合，就能把一个宿主工具对某个 preset 藏起来。

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

往 preset 的组合或其用户补丁层插入一行。`deny` 隐藏点名的工具；`allow` 只保留点名的工具；两者同时给出时取交集：

```yaml
- insert:
    - id: hide-web
      name: '@deepseek-ai/dsh-global-tool-mask'
      config:
        deny: [web_fetch, web_search]
```

掩码跟随本行的 fiber：preset 的常驻组合挂载时生效，该组合被拆除时解除。名字在挂载时检查，因此一个没点名任何工具、或点名了宿主未注册工具的掩码会带着注册表自己的消息让 preset 大声失败，而不是悄悄什么都不遮。作用域内的注册——preset 自己的行注册的工具——永远不受影响；保留的 PTC 传输名也不能被遮蔽。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本行就是包着 `ctx.tools.restrict(config)` 的一个 `ctx.effect()`。每条规则——必须是作用域上下文、过滤器非空、名字已知、保留的传输名——都属于注册表并在那里执行；本行只增加一个 `Config` schema，让手写的组合在加载时得到校验。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `global-tool-mask` 函数插件：`name`、`inject`、`Config`、`apply` |
| — | 不发布运行时不变量伴随件；注册表拥有限制的生命周期，并通过自己的视图报告掩码。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当问题在于掩码作用于什么、或这一行放在哪里时，读这些。

- [工具注册表](../../core/tools/README.zh.md)——`tools.restrict()`、分层视图，以及限制为何需要作用域。
- [Agent presets](../agent-presets/README.zh.md)——本行被插入其中的组合与用户补丁层。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由工具注册表：本行从注册表为作用域内 agent 组装的请求中移除工具 schema，自身不注册任何提示词、schema 或结果。

#### KV Cache 影响

自身无；工具列表由注册表组装，掩码改变的是该列表为某个 preset 的会话从首次请求起携带哪些 schema。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定本行不会做什么。它们是当前包的约束，不是任务清单。

- **仅限全局工具**——掩码藏不住同一 preset 中某行注册的工具；请改为停用那一行。
- **名字在挂载时判定**——preset 挂载后才注册的工具不会被追溯判定：宿主之后新增的名字不可能出现在掩码里，宿主不再注册的名字也让掩码保持原样。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
