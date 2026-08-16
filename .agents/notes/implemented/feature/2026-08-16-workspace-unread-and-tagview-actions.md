# Agent Note: Workspace unread flag, tag-view new-session action, and tag expansion persistence

Status: implemented

## 问题

工作区浏览器的三个缺口：一是标签视图下会话行的右键菜单没有「在此工作区新建会话」（只有工作区视图有，因为菜单依赖分组头 `group.workspaceId`，而标签组没有工作区概念）；二是会话没有「未读」表达，用户想手动标记稍后再看；三是标签组的展开/折叠状态不持久——`retainAccountKeys` 在 Workspace 基线就绪时按工作区键修剪 `groupExpansion`，`tag:*` 与 `UNTAGGED_KEY` 键每次都被清掉，标签视图的展开状态在刷新或工作区变更后重置。

## 决策

**会话行的「在此工作区新建会话」改为按会话归属的工作区。** `SessionNode` 增加 `workspaceId?: WorkspaceId`（无归属工作区的行缺省）；`deriveGroups` 直接传分组工作区，`deriveTagGroups` 与 `deriveFlat` 增加 `workspaces` 参数并构建 session→workspace 映射。行菜单的 `onNewSession` 从 `group.workspaceId` 改为 `node.workspaceId`，标签/单列/工作区三种视图统一可用。菜单文案从「在此目录新建会话」改为「在此工作区新建会话」（两种视图下都准确）。

**未读是浏览器本地元数据，随 `sessionMeta` 持久化。** `SessionMeta` 增加 `unread?: boolean`，新增 `setSessionUnread` action；`SessionNode.unread` 由派生填充；行标题前渲染 8px 品牌色圆点（`aria-label="未读"`）。右键菜单按当前状态显示「标记为未读/标为已读」；点击打开会话自动清除未读（`SessionTree`/`FlatList` 包装 `open`）。搜索行不做未读（瞬态表面）。

**标签组展开状态跨修剪保留。** 把「保留 `tag:` 前缀键」下沉进 store action `retainAccountKeys`（`key.startsWith(TAG_GROUP_PREFIX)`），浏览器 effect 不新增依赖——先前把 `groupExpansion` 加进 effect deps 会因 retain 每次重建对象身份造成无限渲染循环（Maximum update depth exceeded），因此保留逻辑必须放在 action 内部而非调用方。

## 曾考虑的替代方案

- 在调用方 effect 里把 tag 键并入 `retainAccountKeys` 参数（效果等价），但 deps 需要 `groupExpansion`，而 retain 每次生成新对象身份 → 死循环；用 ref 读取可绕开，但逻辑分散。
- 未读存 host 会话属性：会话对象没有未读概念，且这是浏览器视图状态，与 tags/parent 同层最一致。
- 打开会话自动清除未读 vs 手动清除：选择自动清除（与既有 `completed` 提醒打开即清的行为一致）。

## 关联

本决策是 [2026-08-16-workspace-tag-grouping-and-nesting.md](2026-08-16-workspace-tag-grouping-and-nesting.md) 的后续增量：行右键菜单机制与其共享，未取代其任何决策。
