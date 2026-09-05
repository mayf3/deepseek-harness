# Agent Note：插件管理进入 Web 设置

Status: implemented

[English](2026-09-04-plugin-management-in-web-settings.md) | 中文

## 问题

宿主已经能管理 profile 的插件——安装、启用、停用、重试、把行组合进预设——也能按具名 scope 解析 settings 命名空间，但浏览器一样都没暴露。「插件」分区只有一个覆盖每个命名空间全局实例的配置标签页与一个只读列表；想要某个预设的值、或不经 CLI 打开一个 bundle 的人没有任何入口。settings 客户端只读一份 `settings.describe` 应答并把每个命名空间绑定在全局，因此按预设的值没有从文档到卡片的路径。

## 决定

**每个 settings scope 一面镜像。** `ui-settings` 持有 `SettingsMirrorRegistry`：全局镜像如前，每个具名 scope 的镜像在消费方首次绑定或描述它时创建。`settings/document-updated` 事件点名它落在哪个 scope：全局提交重载每一面镜像，因为具名 scope 是在全局分区之上解析的；scoped 提交只重载该 scope。`bind({ namespace, scope })` 从该 scope 的镜像派生并在每次写入时传入 scope；快照携带 `scope`、`registered` 与 `inherited`。

**卡片按 scope 暂存，组件不知道 scope。** `ui-settings-plugins` 为配置标签页持有一个 `ScopeSelection`，每张卡片一个 `ScopedCardForms`：每个 scope 一个 `CardForm`，惰性绑定，草稿属于输入它时所在的 scope。卡片组件读同样的 hooks、调同样的 actions，后者在调用时路由到选中的表单。具名 scope 未覆盖而全局用户层携带的字段报告 `inherited`；重置暂存的是继承值。标签页的开关列出 roster 的预设，外加文档已有分区的任何 scope。文件系统技能提供方得到它的第一张卡片：额外目录的逐行列表。

**管理另开一个标签页。** `ui-settings-plugin-manager` 在配置标签页之后注册**插件管理**标签页。它从 `plugins` Remote 读包、从 `pluginInventory` 读预设组合，在每次操作与每个 `plugins/changed` 之后重新读取，并把 `plugins/install-log` 流进安装对话框。破坏性操作等待一次确认，确认框点名宿主报告的依赖方。安装对话框还会列出宿主在 `pnpm add` 之后又移除掉的包——不是 dsh 包的、行 id 已被别的层占有的组合包——并附宿主的原因；每个操作都会把任何变更都可能遇到的两种拒绝 `plugins/busy` 与 `plugins/agents-running` 按宿主的原话显示出来。

**页面只说两个名词，且都不显示出来。** 不认识 Loader 的人看到的是*插件包*（整体启停、对所有会话生效）与*插件*（经**加入到…**加入某个预设或所有会话），每张卡片只有名字、一句话，以及开关或**加入到…**菜单；只有需重启或异常时才打标签，运行中与已停用由开关表达。内置插件包与其他卡片并列，带*内置*标记与锁定的开关；卸载、重试与插件包的组件都在展开区。预设里的 harness 模块按标签页自己的字典命名（`name.<行 id 或模块 slug>` / `desc.<…>`），自己装的模块按 manifest 的标题与描述命名并带*本地*标记。entry id、模块名、cordis 副本、探测时间、覆盖行都不再出现在页面上；只读的**插件列表**标签页连同其包 `ui-settings-plugin-inventory` 一起删除，`pluginInventory` Remote 保留，作为管理器读取预设组合与宿主树模块名的来源。

**安装动词是 `add`。** 客户端的命名空间服务把 `install` 与 `remove` 留给自己的成员，并在页面加载时——所有单测都通过之后——拒绝同名的挂载方法。宿主的方法与 CLI 一样叫 `plugins/add`，`packages/api/remotes/tests/remote-method-names.host.spec.ts` 用网关源码自己保留的名字检查工作区里每一个 `@Remote('<name>')`。

**web e2e 脚手架可以挂 profile runtime。** `launchWebScaffold({ profileRuntime })` 把 fixture 包链接进脚手架 profile，并以 `patchReload: 'startup'` 在其上挂载 `ProfileRuntime`，于是管理器有 profile 可管，而启动好的树在场景之下绝不重新组合。

## 考虑过的替代方案

**在 `ui-settings` 内部放一个全局的 scope 选择。** 否决：插件标签页之外的表面绑定的是仅全局的命名空间，页面级选择会把它们改指向别处。

**把管理控件放进只读列表。** 否决：列表投影的是在线树的行；管理是按包、基于 profile manifest 的，还有安装运行与确认这些需要自己状态的东西。

**保留 `install` 并在客户端挂载里特判。** 否决：保留名是服务自己的成员；改一个方法名比在网关里多一条查找路径便宜。

## 后果

预设的设置可以在共用设置旁边编辑，scoped 表单写的就是文档的 `scopes.<id>` 树。插件管理器在浏览器里端到端可用：安装、切换、重试、卸载、把行组合进预设。「插件」分区有两个标签页：配置与管理。既有的插件配置 golden 会移动：分区多了一个标签页和一行 scope。

## 测试

`packages/client/ui-settings/tests` 钉住 registry 的路由与 scoped 绑定；`packages/client/ui-settings-plugins/tests` 钉住 scoped 表单、开关、技能卡片与继承标记；`packages/client/ui-settings-plugin-manager/tests` 钉住 store 的读取、操作、安装运行、确认、标签页渲染与名称字典的配对。`apps/web/tests/plugin-manager.e2e.ts` 在脚手架 profile runtime 上驱动管理器并在某个预设 scope 下写一个字段；`plugin-config` 与 `settings-chrome` 的 golden 为两个标签页的分区与 scope 行重录。
