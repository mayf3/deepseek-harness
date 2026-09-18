# Agent Note: Session 行菜单 action slot

Status: implemented

[English](2026-09-17-session-row-menu-actions-slot.md) | 中文

## 问题

Session 行菜单原本是由 `ui-workspace` 持有的封闭 action 列表。第三方客户端插件可以添加独立的侧边栏控件，却无法在不修改 owner 包或复制菜单交互的情况下，把 action 放到 Rename、Fork 与 Archive 旁边。

## 决策

`ui-workspace` 在其 `sidebar.workspaces` 注册项下声明 root-scoped 有序列表 slot `sidebar.workspaces.session.menu.action`。每个贡献项接收目标 `sessionId` 与行 `displayTitle`（依次回退到持久化标题、项目目录名、Session id）；贡献插件将自身服务与 mutation 保留在自己的注册闭包中。

共享 `MenuAction` primitive 在 `Menu` 内渲染所有贡献行。它让贡献行拥有与 owner 定义行相同的菜单项语义、键盘走位、子菜单重置、关闭行为、焦点恢复、禁用状态、图标位置与 danger 样式。动态客户端包将 `ui-primitives` 声明为运行时依赖，再通过 loader 的 `require` 解析宿主共享 export，避免引入第二套组件协议。

### 排序与渐进披露

Rename、Fork 与 Archive 作为固定的 owner-defined 分组保持在顶部。贡献项在下方形成带语义分隔的分组，并遵循 list slot 排序：先按较小的 `order`，再按 live ledger 顺序。`order` 相同的打包注册保持注册顺序；动态注册使用 facade 分配的递减 shadowing priority，因此较新的注册在前。除此之外，priority 只在一个复用 id 的 cell 内选择活动注册，不会让不同 id 跨越 order。空分组在视觉与无障碍 API 中均隐藏。现有省略号菜单仍是唯一的渐进披露层；嵌套「More…」分组不属于此约定。

## 验证

Primitive 测试覆盖选择、关闭、焦点恢复、子菜单重置、语义分隔线与键盘顺序。行测试覆盖 owner props 与内置 action 优先于插件 action 的位置。组装后的 Slot 运行时测试验证不同 priority 下仍以 order 为主。真实 Loader/Web 场景安装动态包，在 Chromium 中打开已播种 Session 的菜单，对组装结果取快照，选择 action，并验证关闭、owner 数据与 fiber 生命周期清理。

## 考虑过的替代方案

**通过 slot owner props 传递菜单 descriptor。** 这会使渲染 slot 变成第二套数据注册表，通过回调暴露展示策略，并阻止普通 slot 组件持有自身注入服务。

**暴露原始菜单 markup。** 这会让插件偏离菜单的无障碍、焦点与视觉行为。要求使用共享 `MenuAction`，可让打包与动态加载的贡献项遵守同一套交互协议。

**立即添加主要 slot 与「More…」slot。** Session action 已位于行省略号之后，而且当前 action 集合不需要另一层渐进披露。在出现已证实的密度问题前，第二层级只会提前增加标签与键盘策略。

## 后果

插件无需编辑 `ui-workspace` 即可添加 Session action，同时 core action 保持稳定位置，外部冲突沿用 slot 注册表已有的 id 与 priority 规则。所有贡献项都使用共享 `MenuAction`。所有插件 action 都保留在次级行菜单内，直到观察到的规模证明需要新层级。
