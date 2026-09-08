# Agent Note: 不增加默认界面的全局主面板

Status: implemented

[English](2026-09-08-global-main-panels.md) | 中文

## 问题

插件需要不属于任何会话的应用级视图。会话作用域的 Conversation 视图无法提供这种生命周期，而替换 Conversation 的 single slot 又会移除普通会话界面。增加此扩展不能在默认应用中增加导航控件或预留空间。

## 决策

布局声明 root 作用域的 keyed `main` slot。保留的 `conversation` key 属于 Conversation 插件，其 `main.conversation` 子 slot 保留可选的会话绑定。其他主面板条目不获得隐式会话绑定。

侧栏拥有 root 作用域的 `sidebar.panellist` list 和 `sidebar.panellist.title` keyed slot。每个 list 条目提供图标，以及与主面板条目匹配的 id；标签提供普通文字和无障碍名称。标题注册可用 React 内容替换可见标签。默认组合不注册面板条目，因此空列表没有 DOM 或间距。

渲染器与布局控制器共享一个直接创建的 root 存储。其 `panelInfo` 和 `layoutInfo` 对象保持独立的引用。框架提供 `usePanelInfo`；各行和中央内容订阅所需的选中态值，AppFrame 仅读取布局信息。右侧 Sidebar 的 root 控制器决定是否挂载其会话子树，并把最终所需的列宽报告给框架。

`uiWorkspace.openSession(id)` 先选中会话，再将中央区域切回 Conversation，包括再次选中同一个会话的情况。新会话和工作区导航使用该操作。面板导航既不取消保留的会话，也不写入会话事件。

## 考虑过的替代方案

**会话作用域的主视图。** 其生命周期和标准 props 会把应用级状态绑定到恰好处于当前态的会话。

**另一套导航栈。** 新会话和工作区会话行已经提供明确目标，不需要返回按钮或保存返回目的地。

**平铺选中态和布局状态，再做浅比较。** 将两者存为独立对象可以直接保持引用相等，避免每次选择面板都分配并比较新的布局投影。

## 后果

默认侧栏快照保持不变。扩展面板没有右侧 Sidebar，选择另一个全局面板不会改变布局偏好。在显示右侧 Sidebar 的 Conversation 与全局面板之间切换时，所需列宽仍会变化；这并不保证浏览器完全不计算布局。

面板选中态是瞬时状态，刷新后重置。插件 dispose（资源释放）会移除其贡献；移除当前选中的主面板条目会使中央区域回到 Conversation。测试覆盖存储引用的独立性、显式会话导航、声明生命周期和默认空侧栏。[Slots 参考](../../../../docs/subsystems/slots.zh.md)拥有组合 API 的说明。
