# Agent Note：Workspace 独占分组与共享任务看板

Status: implemented

[English](2026-08-21-workspace-exclusive-groups-and-board.md) | 中文

## 问题

浏览器本地 `tags?: string[]` 允许同一会话同时出现在多个标签分组；这适合作为筛选，但不适合任务管理看板：卡片重复、跨列拖拽语义不明确，且列内排序无法唯一落账。产品需要类似飞书任务的管理方式：每个任务只在一个分组中，每列一个分组，卡片可以跨列移动并在列内上下排序。

## 决策

**用户组织字段改为唯一分组。** `SessionMeta.group?: string` 是唯一归属，缺省表示「未分组」；`knownGroups` 保留显式创建但暂时没有任务的分组。分组名统一 trim、移除 NUL、限制 32 字符。模型写入 todo 的 `tags` 仍是模型数据，不参与侧栏或看板组织。

**左侧分组视图与看板共用同一份元数据和顺序。** `group:<name>` 与未分组记账键同时持有展开状态和 Session 顺序。左侧「按分组」每个会话只出现一次；看板每列一个分组并固定提供「未分组」列。跨列拖拽调用 `setSessionGroup` 并更新源列／目标列顺序，列内拖拽只更新该列顺序。删除分组会原子清理 `knownGroups`、匹配会话的 `group`、展开状态和顺序记账；任务回到未分组。

**看板是 WorkspaceBrowser 持有的全宽受控 Modal。** 左侧区头按钮打开看板；卡片点击打开会话并关闭看板。看板从 Session 列表与 WorkspaceViewStore 派生，不维护第二份业务状态。搜索、未读、归档和等待父任务仍由既有对象层或浏览器本地状态负责。

**v6 标签数据做一次性 v7 迁移。** 已有 `dsh.workspace.view.v7` 永远优先；否则从 v6 每个 `tags` 数组选择首个合法项作为 `group`，`knownTags` 稳定去重为 `knownGroups`，`tag:*` 展开键映射到 `group:*`，其余 Workspace／flat 顺序、父任务和未读状态保留。迁移同步写入 v7，保留 v6 供回滚；坏 JSON 或存储失败回退到 v7 默认状态。

## 曾考虑的替代方案

**保留多标签并让卡片在多列重复。** 拖拽必须区分移动、复制或移除来源标签，同一任务还会拥有多份互不相关的列内顺序；这不符合任务只归属一个分组的语义。

**新增独立 `boardGroup`，同时保留用户标签。** 当前没有必须保留浏览器本地多标签的消费者，这会产生两套相似组织字段和编辑入口。

**让看板维护卡片副本。** 这会使侧栏、看板和 Session 列表发生漂移；看板必须保持为 Session 状态与 WorkspaceViewStore 的纯投影。

## 后果

分组与卡片顺序只在当前浏览器 profile 中持久化；它们不进入 Session 日志、不通过 Host 同步，也不影响模型可见上下文。迁移含多个旧标签的会话时会有意只保留首个合法标签，保留的 v6 记录可供手动回滚。看板与左侧分组视图因修改同一份元数据和顺序记账而保持一致；新增其他分组界面必须消费这些记账，不能再引入独立状态。

## 关联

本决策部分替代 [2026-08-16-workspace-tag-grouping-and-nesting.md](2026-08-16-workspace-tag-grouping-and-nesting.md) 的多标签／标签分组部分；等待父任务、拖拽中段嵌套和右键菜单决策继续有效。它也部分替代 [2026-08-16-workspace-unread-and-tagview-actions.md](2026-08-16-workspace-unread-and-tagview-actions.md) 的 tag 字段与 tag-view 表述；未读、深链滚动、归档按钮与通知相关决策继续有效。
