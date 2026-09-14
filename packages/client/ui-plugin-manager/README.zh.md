---
description: "从 Web 侧栏管理已安装插件包与全局插件行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-manager

[English](README.md) | 中文

## 概述

使用 Web 侧栏的**插件**入口管理已安装的包。可以启停组合包层、检查插件行与失败、并在安装时查看 pnpm 输出。影响依赖的修改与卸载会要求确认。全局配置仍在设置中编辑。

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

在侧栏选择**插件**。页面首次打开时通过 `api-remotes` 读取包。全局配置仍在设置的**插件**分区中编辑。

### 安装一个包

**添加插件**接受 pnpm 包描述、本地路径或 Git URL。对话框显示命令、实时输出和完成结果，在安装期间保持打开。新组合包可以立即启用。未声明入口的包保持已安装；无效或冲突的组合包声明可能被拒绝，并显示宿主原因。安装成功不代表模块一定能够激活。

### 切换一个插件包

组合包开关改变其启用层选择。实时 profile 在操作完成前重组；仅启动时生效的 profile 显示重启提示。运行失败会保留成功组件和组合包的启用状态，并在详情页提供**重试**与**卸载**。组合包声明不可读时无法启用。内置组合包的开关被锁定。停用会先检查依赖方，必要时要求确认。

### 切换插件包里的一行

包页面上行的开关以 profile 的全局用户层为目标调用 `plugins.setRowDisabled`：关闭往 profile 的 `cordis.patch.yml` 写入该行 id 的 `disabled: true`，打开再把这个键删掉。树随即重组，该行的宿主半区卸下或挂上，插件包其余部分照常运行；插件包自己的客户端 bundle 为每个组件挂载的浏览器半区要到页面重载才消失。开关只在立即生效的地方出现——已打开的外部插件包，且 profile 在运行中就应用补丁；内置插件包、已关闭的插件包，以及下次启动才应用补丁的 profile，其行只读列出。插件包自己关掉的行，无论是 `disabled: true` 的行还是 `!!js` 门，都带原因锁定，因为用户层只能拒绝。异常的行可以关掉；已被别的层占用 id 的行没有挂载任何东西，无从切换。关闭一行前先向宿主询问有哪些行注入它提供的服务，询问期间开关置灰，有则弹出确认框点名它们；没有依赖方的行直接关闭，打开从不询问。超过十行的列表带一个按行 id 筛选的输入框。

### 没有组合包声明的包

非组合包依赖保持已安装，列在**其他已安装包**下。详情页展示包元数据和卸载操作。模块可以通过手写 Cordis 配置加载；此页面不推断模块导出。

-----

<a id="understand-the-implementation"></a>
## 理解实现

插件管理依据 profile 的依赖记录：已安装组合包可启停，已安装包可移除，随安装提供的组合包保持锁定。这一区分不决定启动失败策略。

<details>
<summary>实现细节——点击展开</summary>

### 注册

浏览器插件通过 `ctx.slots.inject()` 注册 `plugins` 侧栏入口与它的 `main` 面板，使两者跟随 slot 延迟声明、本地化变化与销毁。页面为全局页面，不属于任何 Session。随附模块的标签来自字典，第三方显示文本来自包元信息。

### store

`PluginManagerController` 拥有包快照、忙碌键、提示、安装进度和确认状态。它合并重叠读取，在操作或 Host 变化后刷新，并在销毁后忽略晚到结果。安装输出按 job id 分组。

### 确认

`disable` 与 `uninstall` 打开确认框并询问 `plugins.dependents`；确认框此后已变化时丢弃这份应答。空应答的停用自行确认。对话框把每个依赖方说成人话——注入该包所提供服务的行按 harness 名称点名，引用该包的用户层行按包标题与所在层点名——确认按钮在应答到达前保持禁用。确认框守护的操作在打开时捕获，只经该按钮运行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面覆盖设置分区、Remote 调用与宿主侧管理器。

- [ui-sidebar](../ui-sidebar/README.zh.md)——「插件」入口注册进的面板列表；[ui-layout](../ui-layout/README.zh.md)——页面所占的 main slot。
- [api-remotes](../../api/remotes/README.zh.md)——`plugins.*` 背后的 Remote BFF 表面。
- [plugin-manager](../../host/plugin-manager/README.zh.md)——本页面驱动的宿主侧管理器。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的管理表面，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定管理视图的范围；它们是本包当前的约束。

- **用户层行不按包列出**——手写 patch 中的模块引用会出现在依赖查询中，并在卸载时清理；编辑这些行仍通过文件完成。
- **harness 模块的名字放在本页面的字典里**——新的第一方 agent 面模块在补上 `name.<slug>` 之前按短模块名显示。
- **一次只能安装一个**——对话框运行一条 pnpm 命令；第二个 spec 要等第一个结束。
- **没有版本选择器**——spec 按 pnpm 接受的写法输入；页面既不列出仓库版本也不提供升级。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。本包拥有一个侧栏面板与一个基于宿主事实的设置贡献。
