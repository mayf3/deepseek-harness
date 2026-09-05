---
description: "dsh Web 客户端的「插件」设置分区：功能拥有的标签页、可配置宿主平面插件卡片，以及 settings.plugin.item 扩展点。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugins

[English](README.md) | 中文

## 概述

`dsh-client-ui-settings-plugins` 是 dsh Web 客户端的**插件**设置分区：用户在其**插件配置**标签页上编辑宿主平面插件配置，功能插件则通过 `settings.plugins.tab` 贡献自己的页面。本包自己的标签页为每个配置由用户拥有的 Host 插件展示一张可展开卡片：卡片展示插件名称及其管辖范围，展开后是绑定到该插件 settings 命名空间的手写控件，每个字段标注用户是否覆盖过它，并提供重置回部署组装值的入口。标签页编辑所有 Agent 预设共用的值；同样的卡片构成 Agent 预设分区里每个预设详情页的**设置**段，在那里编辑该预设自己的值，字段会标注它是否继承共用值。卡片按范围暂存用户输入，只有用户保存时才写入，且每次写入都以表单读取时的命名空间 revision 设栅。

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

打开设置中的「插件」分区并选择**插件配置**标签页，即可编辑本部署所组装的宿主平面插件。卡片依次为 shell 执行器（`bash`）、agent 循环的工具调用并行度（`agent-loop`）、subagent 模型选择（`subagent-model-selection`）、DeepSeek 搜索提供方（`web-search-deepseek`）以及文件系统技能提供方的额外目录（`skill-filesystem`）。

### 预设自己的值

预设的详情页——Agent 预设分区里卡片上的齿轮之后——带一个**设置**段，用同样的卡片编辑该预设的命名作用域（`preset/<id>`）。在那里，预设未覆盖的字段在共用用户层持有它时显示**继承**，重置暂存的是继承值而非组装默认值，而所属插件没有被该预设任何运行中会话加载的卡片会如此说明——其值照样存储，对加载该插件的会话生效。草稿属于输入时所在的作用域，离开页面后仍在。配置标签页始终编辑共用值。

### 这里会出现什么

标签页读取 Host 服务了哪些 settings 命名空间，并为每个命名空间派发一个 slot 键，因此渲染出来的是两份账本的交集：存活 Host 插件注册的命名空间，以及注册在这些键上的卡片。被服务却无人认领的命名空间什么都不渲染；命名空间未被本部署服务的卡片根本不会被派发。空态文案要等 Host 的第一次答复，因此一次尚未答复的读取绝不会被读成「本部署没有可配置的插件」。

### 编辑与保存

卡片暂存用户输入，只有用户保存时才写入。每个控件渲染的都是暂存文本，因此屏幕上所见即保存后所存；**放弃修改**丢弃这些草稿，持有未保存修改的卡片即使收起也会在标题上标明。保存成功后，卡片会在回读确认写入后收起；保存失败时，卡片保持展开、报告失败并保留草稿供用户修改。重置暂存的是组装默认值而非立即写入；字段不接受的草稿会阻塞保存，而不是被丢弃。某个值是否被接受只有 Host 说了算。

Subagent 卡会同时暂存其权限开关与精确模型复选框。启用时必须至少选择一条适配器路由。保存会在一次 mutation 中提交 `enabled` 与 `allowedModels`，并以草稿开始时的 revision 设栅；Host revision 更新后，草稿会标记为失败，而不会恢复已撤销的路由。关闭时会保留已选路由供以后重新使用。可用模型按提供方分组；当前目录中缺失的已存路由排在末尾，且仍可移除。适配器名称与模型描述仍属于实时目录元数据，不会存储；适配器变化、设置提交和重连后，卡片会刷新这些元数据。

### secret 角色字段

密钥控件初始为空、只报告是否已配置，并经由 credentials 领域而非 settings 分节写入；空草稿不写入任何东西，保留已存密钥。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本分区是一个扩展点加一条分派规则：功能插件拥有各自的卡片；标签页按 slot 键把被服务的命名空间与已注册卡片配对。

### 标签页扩展点

本分区声明根级列表 slot `settings.plugins.tab`，其标签会成为有序标签页；某个标签页首次被选择后会保持挂载，因此本地草稿与只读快照在切换标签页时不会丢失。本包注册自己的 `configurable` 贡献，由它声明嵌套的 `settings.plugin.item` slot——以卡片所编辑的 settings 命名空间为键。带浏览器半侧的插件把自己的卡片注册在自己的命名空间上，并拥有它的全部：外观、控件与文案。标签页遵循贡献的 `order`；卡片遵循注册顺序。预设设置段注册进名单的 `settings.agentPreset.detail` 槽位并声明按同样方式键控的 `settings.agentPreset.plugin.item`；卡片在两个槽位下都注册才会出现在两个表面上。一个作用域选择服务所有卡片——配置标签页显示时是全局实例，预设详情页打开时是该预设的作用域；设置外壳一次只挂载一个分区，因此两者从不竞争。

### 写入路径

保存时，暂存字段通过客户端 settings scope 写入；每次单字段写入或有序 mutation 都以草稿读取时的命名空间 revision 设栅，因此已与文档脱节的表单会被拒绝，而不是覆盖并发变更。字段是否被覆盖，取决于它是否出现在原始用户层中，而非取决于它的值；重置会清除该字段，使其重新继承组装层。secret 角色的字段绝不搭乘响应；卡片会在转发来的 `credentials/reference-updated` 事件报告它所关注的引用时重读。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置底座、清单标签页与卡片背后的持久化 seam。

- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.plugins.tab` 与 settings scope 的领域底座。
- [settings](../../settings/README.zh.md)——持久化用户设置 seam 及其文件提供方。
- [credentials](../../credentials/README.zh.md)——secret 字段写入所经的凭据引用 seam。
- [ui-settings-general](../ui-settings-general/README.zh.md)——承载本分区的设置外壳。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端设置界面，不注册任何面向模型的表面。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义哪些插件会出现、列表有多新鲜；它们是当前包约束。

- **只有宿主平面的插件会出现**：由 agent preset 挂载的插件把配置内联在该 preset 的 `agent.cordis.yml` 中，且根本无法注册 settings 命名空间，因此本分区不会列出它。编辑那些值仍是 preset 编辑器的职责。
- **卡片仍然需要一份浏览器 bundle**：浏览器半侧必须是按客户端模块系统的 lazy-CJS factory 格式构建的 `dsh.client` 包，而产出它的 `clientBundle` 预设位于 `../../../packages/client/tsdown.client.ts`，并非已发布的包，因此本仓库之外的插件得自行复刻该构建。
- **被服务的命名空间只在两种信号上重读**：协议通告的是 settings 文档提交与连接重置，而非注册行为，因此在标签页读取之后才被其拥有方注册的命名空间，要等下一次文档提交或重连才会加入列表。
- **孤儿作用域段没有界面**：预设已被删除的 `scopes.<id>` 段无处编辑——会显示它的详情页已不存在，而配置标签页只编辑共用值，因此该段一直留在文档里，直到手工编辑。
- **shell 卡片跟随被组装的执行器**：POSIX 与 PowerShell 两个执行器家族共用 `bash` 命名空间，因为一个宿主只组装其中之一，所以被服务的 schema 随平台不同（PowerShell 多出 `pwshPath`），尽管卡片在两者下编辑的都是同样两个字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是浏览器侧 settings surface，node half 不持有事件流或可变运行时数据；layering 与写入拒绝由所属 Host 插件和 api-proxy 覆盖。
