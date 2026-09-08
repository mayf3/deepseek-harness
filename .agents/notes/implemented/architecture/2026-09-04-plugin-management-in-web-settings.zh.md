# Agent Note：插件管理进入 Web 设置

Status: implemented

[English](2026-09-04-plugin-management-in-web-settings.md) | 中文

## 问题

宿主已经能管理 profile 的插件——安装、启用、停用、重试、把行组合进预设——也能按具名 scope 解析 settings 命名空间，但浏览器一样都没暴露。「插件」分区只有一个覆盖每个命名空间全局实例的配置标签页与一个只读列表；想要某个预设的值、或不经 CLI 打开一个 bundle 的人没有任何入口。settings 客户端只读一份 `settings.describe` 应答并把每个命名空间绑定在全局，因此按预设的值没有从文档到卡片的路径。

## 决定

**每个 settings scope 一面镜像。** `ui-settings` 持有 `SettingsMirrorRegistry`：全局镜像如前，每个具名 scope 的镜像在消费方首次绑定或描述它时创建。`settings/document-updated` 事件点名它落在哪个 scope：全局提交重载每一面镜像，因为具名 scope 是在全局分区之上解析的；scoped 提交只重载该 scope。`bind({ namespace, scope })` 从该 scope 的镜像派生并在每次写入时传入 scope；快照携带 `scope`、`registered` 与 `inherited`。

**卡片按 scope 暂存，组件不知道 scope。** `ui-settings-plugins` 为配置标签页持有一个 `ScopeSelection`，每张卡片一个 `ScopedCardForms`：每个 scope 一个 `CardForm`，惰性绑定，草稿属于输入它时所在的 scope。卡片组件读同样的 hooks、调同样的 actions，后者在调用时路由到选中的表单。具名 scope 未覆盖而全局用户层携带的字段报告 `inherited`；重置暂存的是继承值。标签页的开关列出 roster 的预设，外加文档已有分区的任何 scope。文件系统技能提供方得到它的第一张卡片：额外目录的逐行列表。

**管理另开一个表面。** `ui-settings-plugin-manager` 起初在配置标签页之后注册**插件管理**标签页；现在注册侧栏的**插件**入口与它打开的主面板（[插件管理移到 Web 侧栏](2026-09-09-plugin-management-in-the-web-sidebar.zh.md)）。它从 `plugins` Remote 读包、从 `pluginInventory` 读预设组合，在每次操作与每个 `plugins/changed` 之后重新读取，并把 `plugins/install-log` 流进安装对话框——每次 pnpm 运行一块共享的 `TerminalBlock`，画出宿主保留的颜色。破坏性操作等待一次确认，确认框点名宿主报告的依赖方。安装对话框还会列出宿主在 `pnpm add` 之后又移除掉的包——不是 dsh 包的、行 id 已被别的层占有的组合包——并附宿主的原因；每个操作都会把任何变更都可能遇到的两种拒绝 `plugins/busy` 与 `plugins/agents-running` 按宿主的原话显示出来。

**页面只说两个名词，且都不显示出来。** 不认识 Loader 的人看到的是*插件包*（整体启停、对所有会话生效）与*插件*（经**加入到…**加入某个预设或所有会话），每张卡片只有名字、一句话，以及开关或**加入到…**菜单；只有需重启或异常时才打标签，运行中与已停用由开关表达。内置插件包与其他卡片并列，带*内置*标记与锁定的开关；卸载、重试与插件包的组件都在展开区。预设的组合不在这个页面上：Agent 预设分区声明 `settings.agentPreset.detail` 槽位，每张预设卡片带一个打开详情页的齿轮，管理器把**能力**段注册到那里——预设的行仍是同样的卡片，用户添加的行带**删除**，段头的**添加**菜单列出预设还没有的已安装模块——于是标签页只说装了什么，预设页说一个预设能做什么。插件配置标签页出于同样的理由去掉了作用域切换：它编辑所有预设共用的值，而同样的卡片构成详情页的**设置**段，注册在第二个键控槽位（`settings.agentPreset.plugin.item`）下，在页面打开期间编辑该预设自己的作用域；设置外壳一次只挂载一个分区，因此一个作用域选择服务两个表面。两个表面都建立在 `ui-primitives` 的共享控件之上——`Switch`、`Tag`、`Button`、`Input`、`StateDot`——只保留目录里没有答案的部分：28px 图标按钮、用户添加行上的红色垃圾桶图标、组件标签。预设里的 harness 模块按标签页自己的字典命名（`name.<行 id 或模块 slug>` / `desc.<…>`），自己装的模块按 manifest 的标题与描述命名并带*本地*标记。entry id、cordis 副本、探测时间不再出现在页面上，包页面则给出每行加载的模块与插件包覆盖的内置行；只读的**插件列表**标签页连同其包 `ui-settings-plugin-inventory` 一起删除，`pluginInventory` Remote 保留，作为管理器读取预设组合与宿主树模块名的来源。

**每个包有自己的页面，插件包的行在那里逐个切换。** 卡片只留摘要——名称、一句话描述、标签、开关或**加入到…**——并像预设卡片进入详情页那样经面包屑进入该包的页面：版本与来源、行的列表、插件包改动的内置行、声明的可加入模块及各自已加入的位置，以及重试与卸载；宿主说不出的东西一概不放，没有探针时间、安装来源或能力计数。外部插件包在实时应用补丁的 profile 上组合时，每一行带一个 `Switch`，以全局用户层为目标调用 `plugins.setRowDisabled`——关闭往 profile 的 `cordis.patch.yml` 写入该行 id 的 `disabled: true`，打开删掉这个键——该行的宿主半区随之卸下或挂上，插件包其余部分照常运行。内置插件包、已关闭的插件包，以及下次启动才应用补丁的 profile 只读列出各行：开关在那里只会写文件而页面上什么都不变。插件包自己关掉的组件带原因锁定，因为用户层只能拒绝；异常的组件可以关掉；被别的层占用 id 的行无从切换。关闭一行时，若有别的行注入它提供的服务就先询问——用包级 `dependents` 的答案按本行提供的服务过滤，复用停用插件包的那个确认框——让人在关之前就知道哪些行会进入等待。等待服务的行不论是就地重组把 fiber 留在挂起状态，还是全新组合把这次等待记成 `inject-pending` 失败，都读作同一个状态：行上和插件包标签上都是*等待依赖*，*异常*只留给真正的失败。像 dsh-web 聚合包那样由自己的客户端 bundle 挂载全部组件浏览器半区的插件包，那一半会留在页面上直到重载；它需要的行状态信号就是 `plugins` Remote 已按行给出的 `enabled` 与 `disabledBy`。

**安装动词是 `add`。** 客户端的命名空间服务把 `install` 与 `remove` 留给自己的成员，并在页面加载时——所有单测都通过之后——拒绝同名的挂载方法。宿主的方法与 CLI 一样叫 `plugins/add`，`packages/api/remotes/tests/remote-method-names.host.spec.ts` 用网关源码自己保留的名字检查工作区里每一个 `@Remote('<name>')`。

**web e2e 脚手架可以挂 profile runtime。** `launchWebScaffold({ profileRuntime })` 把 fixture 包链接进脚手架 profile，并以 `patchReload: 'startup'` 在其上挂载 `ProfileRuntime`，于是管理器有 profile 可管，而启动好的树在场景之下绝不重新组合。

## 考虑过的替代方案

**在 `ui-settings` 内部放一个全局的 scope 选择。** 否决：插件标签页之外的表面绑定的是仅全局的命名空间，页面级选择会把它们改指向别处。

**把管理控件放进只读列表。** 否决：列表投影的是在线树的行；管理是按包、基于 profile manifest 的，还有安装运行与确认这些需要自己状态的东西。

**保留 `install` 并在客户端挂载里特判。** 否决：保留名是服务自己的成员；改一个方法名比在网关里多一条查找路径便宜。

## 后果

预设的设置可以在共用设置旁边编辑，scoped 表单写的就是文档的 `scopes.<id>` 树。插件管理器在浏览器里端到端可用：安装、切换、重试、卸载、把行组合进预设。「插件」分区就是配置页；管理在侧栏的「插件」面板。既有的插件配置 golden 会移动：分区多了一个标签页和一行 scope。

## 测试

`packages/client/ui-settings/tests` 钉住 registry 的路由与 scoped 绑定；`packages/client/ui-settings-plugins/tests` 钉住 scoped 表单、开关、技能卡片与继承标记；`packages/client/ui-settings-plugin-manager/tests` 钉住 store 的读取、操作、安装运行、确认、页面渲染及其组件开关与名称字典的配对。`apps/web/tests/plugin-manager.e2e.ts` 在脚手架 profile runtime 上驱动管理器并在某个预设 scope 下写一个字段；`plugin-config` 与 `settings-chrome` 的 golden 为该分区与 scope 行重录。
