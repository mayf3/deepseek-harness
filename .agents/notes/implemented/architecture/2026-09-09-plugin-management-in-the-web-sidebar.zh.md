# Agent Note：插件管理移到 Web 侧栏

Status: implemented

[English](2026-09-09-plugin-management-in-the-web-sidebar.md) | 中文

## 问题

[插件管理进入 Web 设置](2026-09-04-plugin-management-in-web-settings.zh.md)把管理器放在设置对话框「插件」分区的一个标签页上，与配置标签页并列。设置是盖在当前 Session 之上的模态框，而一个在管理已安装内容的人心里并没有 Session；对话框的宽度和一次只显示一个分区的外壳，也放不下包页面、安装运行与列表并排。布局此后有了侧栏入口背后的根级主面板（[全局主面板](2026-09-08-global-main-panels.zh.md)），这正是管理器需要的生命周期与空间。

## 决定

**管理是侧栏入口；配置留在设置里。** `ui-plugin-manager` 用同一个 id `plugins` 注册一个 `sidebar.panellist` 条目和它打开的 `main` 面板：侧栏渲染本地化的**插件**标签，本包提供图标与页面。页面是根级作用域，不绑定任何 Session；它带自己的标题、简介、刷新与**添加插件**，并在主列内部滚动。页面显示的内容没有变：插件包与插件、每个包的页面、安装对话框与各个确认框都来自原来的标签页。设置的**插件**分区保留插件配置，`ui-settings-plugins` 把唯一的 `settings.plugins.tab` 贡献直接渲染成这一页，没有标签条，因此该分区读起来就是它现在的样子——配置页。设置里的预设详情页保留读同一个 store 的**能力**段。

**配置不搬。** 插件的配置把一个 settings 命名空间绑定在某个 scope 下——全局实例或某个预设——而设置外壳拥有这套 scope 机制，一处选择同时服务分区与每个预设的详情页。把卡片搬到管理页会复制外壳的 scope 选择，并把设置拆到两个入口，而人找一个值时会去设置里找。等设置能按分区打开后，插件自己的页面会转而指向它的可配置分区，那只需要一个深链接。

## 考虑过的替代方案

**用一个设置分区打开管理页。** 否决：对话框盖住主列，这样的入口必须先关掉设置才能显示页面。

**把配置放在插件页面上。** 暂不采纳，理由见决定；等设置能按分区打开后，它会变成插件页面上的一个链接。

## 后果

web bundle 的面板列表不再为空：**插件**入口位于新建会话与工作区之间。设置的「插件」分区显示没有标签页的配置页。`apps/web/tests/plugin-manager.e2e.ts` 经侧栏到达管理器，`plugin-config` 与 `settings-chrome` 的场景与 golden 随之更新。

## 测试

`packages/client/ui-plugin-manager/tests` 钉住同一 id 下的两处注册与页面的渲染；`packages/client/ui-settings-plugins/tests` 钉住没有标签条的单一贡献；上述 web e2e 场景在脚手架上驱动面板与分区。
