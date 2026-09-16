---
description: "Web \"Open In...\" 控件：会话头部在记住的应用中打开 workspace 目录的分体按钮，以及文档预览里用默认应用打开、显示单个文件位置的控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

[English](README.md) | 中文

## 概述

本包提供 open-in-app 功能的浏览器表面。会话头部的分体按钮在记住的应用中打开当前会话的 workspace 目录（会话摘要的 `cwd`），下拉箭头列出主机探测到已安装的全部 catalog 应用；可用性、图标与启动均来自 [`dsh-host-open-in-app`](../../host/open-in-app/README.zh.md) 的主机路由，所以两个包要一起挂载。在右侧 Sidebar 的文档预览里，一个「打开」分体按钮和一个空态按钮经由 Session Remote 用默认应用打开当前文件或显示其位置。主机没有这项能力时，这些控件一个都不渲染。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件与 [`dsh-host-open-in-app`](../../host/open-in-app/README.zh.md) 并排挂进 Web 组合；这对包用两行 cordis.yml 组成完整功能，本行不接受任何配置。只要主机探测到至少一个已安装的 catalog 应用且会话有已知的 workspace 目录，会话头部就会出现 "Open In..." 分体按钮。只要 Host 通过 Session Remote 的 `session.canOpenWorkspacePath` 报告有桌面，[`ui-sidebar-documentpreview`](../ui-sidebar-documentpreview/README.zh.md) 的文档预览就会长出文件控件；删掉这一行会一次去掉所有控件。

### 预期行为

主按钮显示记住的应用图标——凡主机能提取的都是应用真实图标（macOS bundle 图标、Windows 可执行文件图标、Linux 主题图标），提取不到时是通用占位图形——并带设计系统 tooltip（「在本地打开」）；点击立即启动。下拉箭头打开已安装应用的紧凑菜单，记住的条目以整行填充标记。可用性每页读取一次；上次选择的应用持久化在浏览器中（`dsh.open-in-app.choice`），不再安装的选择回退到第一个可用条目。快速完成的启动不改变按钮外观——变暗的等待态只在飞行超过 250 毫秒后出现——失败的启动显示错误 tooltip 与红色描边两秒。所有文案在双语 `open-in-app` locale 命名空间中；词典无法命名的应用 id 不会被提供。

在文档预览里，头部的「打开 ▾」分体按钮的主按钮用 Host 默认应用打开当前文件，菜单提供同一动作和「显示文件位置」（文件管理器的定位）。预览无法渲染的文件，无论是视频、压缩包这类不支持的后缀，还是被读取器判为非文本或过大的文件，都会在空态里原本放重试的位置显示「使用默认应用打开」按钮。两个控件都把文件元数据报出的绝对路径交给 Host，只在 Host 回答有桌面之后出现，只在自己的手势结算期间禁用，失败时通过短暂 toast 提示一次（「打开失败，请重试」或「无法显示文件位置，请重试」），之后控件上不残留任何状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

插件通过标准 slot/inject 机制把分体按钮注册到 `conversation.session.header.utilities`，并以一个 effect 注册 `open-in-app` 词典。一个页面生命周期的 controller（[`src/client/controller.ts`](src/client/controller.ts)）拥有每页一次的可用性读取、持久化选择的 snapshot store 与启动 POST；组件经 inject 的 `hooks` 隔间接收两个 store，因此所有会话头部共享同一份事实。路由路径与 wire 载荷类型从主机包的浏览器安全子路径 `@deepseek-ai/dsh-host-open-in-app/shared` 内联。飞行中的启动由 ref 守卫——启动期间的重复点击与菜单选择被整体忽略（否则会持久化一个该手势从未打开的选择）——busy/error 视觉由围绕 `launch` promise 的定时器驱动。

文件控件注册在文档预览的 `sidebar.right.tab.document.actions` 与 `sidebar.right.tab.document.unpreviewable` 子 slot 上，owner props 携带当前文件及其 Host 绝对路径。第二个页面生命周期的 controller（[`src/client/open-path.ts`](src/client/open-path.ts)）每页读取一次 Session Remote 的 `session.canOpenWorkspacePath`，写进两个控件共用的桌面 snapshot store，并把每个手势交给 `session.openWorkspacePath`，带上路径，定位时再带 `action: 'reveal'`；被拒绝或抛错的调用解析为控件要提示的失败种类。两个控件共用一个手势 hook，由它持有 pending 标志和 toast，所以一个控件的手势不会改变另一个控件的样子。节点半边是一个空 `apply`，让插件出现在主机侧的插件名册上。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-host-open-in-app](../../host/open-in-app/README.zh.md)——提供可用性、图标与启动的主机路由，及其背后的目录。
- [dsh-session-log-export](../../session-query/session-log-export/README.zh.md)——会话头部的姊妹动作。
- [ui-sidebar-documentpreview](../ui-sidebar-documentpreview/README.zh.md)——声明文件控件所占头部与空态子 slot 的文档预览。
- [ui-deliverables](../ui-deliverables/README.zh.md)——交付卡片，仍通过自己的路由打开声明过的文件。
- [Web client 架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

无。分体按钮是浏览器 chrome；这里没有任何东西进入模型请求。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **词典把守菜单。** 主机目录的新条目若在两份词典中没有对应的 `app.<id>` 条目，将保持不可见而不是显示裸 id；扩展目录意味着同时扩展 [`dsh-host-open-in-app`](../../host/open-in-app/README.zh.md) 与本包的 locale。
- **可用性每页只读一次。** 页面打开期间安装的应用要重新加载页面后才出现（主机侧还需主机重启）；文件控件背后的桌面回答同样每页只读一次。
- **所有平台共用一个定位标签。** Session Remote 只报告有没有桌面，不报告它跑的是哪个文件管理器，所以菜单写「显示文件位置」，而不像交付卡片那样点名访达或文件资源管理器。
- **交付卡片保留自己的打开器。** [`ui-deliverables`](../ui-deliverables/README.zh.md) 仍通过自己按 Session 与事件定位的路由打开声明过的文件；把这些卡片并到这里的文件控件上，延后到 [Agent Note](../../../.agents/notes/implemented/feature/2026-09-16-open-in-default-app-for-sidebar-files.zh.md) 记录的后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作语境——点击展开</summary>

功能层面的各项决定，包括拆分为主机包与本表面包，记录在[转正 Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-promote-open-anywhere-plugin.zh.md)；文档预览的文件控件记录在[默认应用 Agent Note](../../../.agents/notes/implemented/feature/2026-09-16-open-in-default-app-for-sidebar-files.zh.md)。

</details>

**运行时不变式：** 不发布伴生入口。插件注册一个词典 effect 和三个 slot 条目，HMR 安全性 spec 证明它们都会在资源释放时撤销；应用可用性、选择与桌面回答存储在控制器的快照存储中，不存在可能与之分歧的第二份副本。
