---
description: "面向浏览器的 Activity Remote 流：activity.control roster 流、带 flushMs 合并与 maxFrameBytes 预算的逐活动 activity.observe 输出流，以及 ctx.activityFeed 客户端模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-activity-controller

[English](README.md) | 中文

## 概述

`dsh-api-activity-controller` 把实时活动面流式提供给浏览器：客户端跟随一条 roster 流获得每个可见任务行，并为每个展开的面板打开一条观察流，重连后从自己的游标续传。它是纯读表面——什么都不启动、什么都不取消、从不触碰模型可见的消费游标；线路路径只读注册表的非消费偏移。没有 `ctx.activities` 的组合仍提供空 baseline，客户端退化为没有实时行而非报错。

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

在 `dsh-typert-registry` 旁挂载宿主行，并经插件清单加载客户端半侧；UI 功能随即消费 `ctx.activityFeed` 而非裸流。

### 两条 Remote 流

宿主 `ActivityController`（命名空间 `activity`）暴露两个 `@Remote({ mode: 'stream' })` 方法：

- `control(signal)`——一份完整 roster baseline，之后每次注册表变化按 owner 会话推送整桶替换帧（与 session control 流承载 jobs 的自愈形态一致）。没有注册表的组合返回空 baseline。Remote 层有意把所有会话的行提供给任何已连接的浏览器，`observe` 以镜像到的 owner 替调用方满足注册表的 owner 栅栏：按会话的栅栏是进程内契约，这个单用户本地 BFF 跨栅栏读取，与 session control 流对 `jobsBySession` 的做法完全一致。
- `observe({ activityId, from? }, signal)`——一帧 `opened` 锚点、合并后的 `output` 帧（`flushMs` 窗口，`maxFrameBytes` 软预算；单个更大的 chunk 整块发出），已结算活动排空后一帧终态 `status`，随后本代正常关闭。重连调用方传上一帧的 `next` 续传；落后于留存窗口的续传带 `lossy` 标记到达。status 与 output 走同一条流，结算绝不会与仍开放的输出通道赛跑。

| 配置 | 默认 | 含义 |
|---|---|---|
| `flushMs` | `100` | 新输出后进行一次观察读取前的合并窗口。 |
| `maxFrameBytes` | `65536` | 每个观察输出帧的软字节预算。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-activity-controller)是每个可接受字段的穷尽来源。

### 客户端 feed

客户端半侧（`./client`）安装 `ctx.activityFeed`：`ClientActivityModel` 镜像 roster（last-wins 桶、按代整体替换）并累积每个被观察活动的有界渲染尾部，`ClientActivityFeed.observe(id)` 打开引用计数的观察流，跨 carrier 代从模型游标续传。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

宿主侧把注册表镜像进 owner 桶（`ActivityFeed`），向每代 follower 扇出 control 帧，并把每个观察跑成先订阅再首读的 async generator，锚点与流之间不会漏 append。客户端侧按活动保存观察状态与续传游标；release 闭包绑定自己创建时的那个条目，被替代观察的迟到 release 既拆不掉也清不掉后继者。

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ActivityController`：两个 Remote 流方法 |
| [`src/feed.ts`](src/feed.ts) | owner 桶 roster 镜像与 control 流 follower |
| [`src/observe.ts`](src/observe.ts) | 逐活动观察 generator：锚点、合并、终态 status |
| [`src/client/model.ts`](src/client/model.ts) | roster 与观察状态，含有界渲染尾部 |
| [`src/client/service.ts`](src/client/service.ts) | `ctx.activityFeed`：引用计数的观察流 |
| [`src/client/index.ts`](src/client/index.ts) | 客户端插件：roster 流接线与服务安装 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-activity`](../../activity/activity/README.zh.md)——本传输所读的观察契约。
- [`dsh-client-ui-activity`](../../client/ui-activity/README.zh.md)——渲染 `ctx.activityFeed` 的任务列表。
- [docs/subsystems/activity.md](../../../docs/subsystems/activity.zh.md)——端到端的观察面，含线路形态。

-----

<a id="model-experience"></a>
## 模型体验

无：activity 传输是浏览器与宿主的观察状态，不注册任何 prompt、工具或会话事件。

#### KV Cache 影响

无；本包从不组装或改动 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该传输何时不合适。它们是当前包约束，不是任务积压。

- **注册表存在性在构造时采样**——controller 之后才挂载的注册表在 controller 重载前保持不被观察。
- **roster 不命名水位**——观察流自行锚定；把 roster 行与观察偏移相关联是客户端策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
