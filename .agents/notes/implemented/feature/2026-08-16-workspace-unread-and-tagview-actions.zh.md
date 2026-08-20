# Agent Note: 工作区未读状态、标签视图会话创建与展开持久化

Status: implemented

[English](2026-08-16-workspace-unread-and-tagview-actions.md) | 中文

本决策部分被[独占分组与共享任务看板](2026-08-21-workspace-exclusive-groups-and-board.md)替代：tag 字段与 tag-view 表述停止生效；未读、深链滚动、归档按钮与通知相关决策继续有效。

## 问题

工作区浏览器存在三个相关缺口。标签视图无法在所选行所属的工作区中创建会话，因为标签组没有工作区标识。会话没有由用户控制的未读状态。标签组展开状态也会重置，因为每当工作区基线变化时，工作区键修剪都会从 `groupExpansion` 中删除 `tag:*` 与 `UNTAGGED_KEY` 条目。

## 决策

**“在此工作区新建会话”跟随会话行所属的工作区。** `SessionNode` 携带可选 `workspaceId`。`deriveGroups` 直接传递分组工作区，`deriveTagGroups` 与 `deriveFlat` 则接收 `workspaces` 并构建会话到工作区的映射。行菜单读取 `node.workspaceId`，因此在归属已知时，该操作可用于工作区、标签和单列视图。

**未读状态是持久化在 `sessionMeta` 中的浏览器本地元数据。** `SessionMeta` 包含 `unread?: boolean`，`setSessionUnread` 负责更新。派生行暴露 `SessionNode.unread`；标题渲染一个 8 px 品牌色圆点，并带有可访问的未读标签。右键菜单切换状态，打开会话则会清除状态。搜索结果是瞬态内容，不处理未读状态。

**标签组展开状态在工作区修剪后仍会保留。** `retainAccountKeys` 保留带 `TAG_GROUP_PREFIX` 的键。该规则属于存储 action：如果浏览器 effect 依赖 `groupExpansion`，保留操作每次创建的新对象标识都会重新触发 effect。

**标签支持整体删除与自动补全。** `removeTag(tag)` 会从所有会话元数据、`knownTags` 以及相应的 `tag:<name>` 展开键中删除标签。标签标题通过右键菜单提供危险操作“删除标签”。会话标签编辑器和新建标签对话框共享一个 datalist，其内容来自 `knownTags` 与会话元数据，并经过去重和排序。

**从行创建的会话继承来源行标签。** `startSession` 不返回新会话 id，因此 `SessionTree` 与 `FlatList` 会在调用前保存 `{ workspaceId, tags }`。当该工作区中的空白会话成为当前会话后，effect 会一次性应用这些标签并清除待处理记录；其他工作区的会话不会被误标。

**未读过滤与深链滚动定位是持久化视图行为。** `unreadOnly` 与视图状态一起存储。过滤启用时，工作区、标签与单列派生会移除已读行并隐藏空分组。会话行暴露 `data-session-id`；当前会话变化后，系统轮询该行并调用 `scrollIntoView({ block: 'nearest' })`。标签视图会在滚动前展开当前会话所在的标签组。

**行内操作只保留归档，其他操作使用右键菜单。** 归档图标使用[工作区批量归档选择](2026-08-20-workspace-bulk-archive-selection.md)定义的行内二次点击确认。重命名、分叉、标签、未读状态与会话创建保留在行右键菜单中，并根据记录的指针坐标定位。

## 曾考虑的替代方案

**在调用方 effect 中把标签键并入 `retainAccountKeys`。** 未采用，因为 effect 会依赖 `groupExpansion`，而保留操作创建的新对象标识可能造成最大更新深度循环。把规则放在存储 action 中可以保留单一更新边界。

**把未读状态存到 Host 会话。** 未采用，因为会话模型没有未读属性，而未读状态与标签、父子关系一样属于浏览器展示元数据。

**要求用户手动清除未读状态。** 未采用，因为打开会话就是确认点，也与完成通知的行为一致。

## 后果

三个工作区视图共享会话创建与未读行为，标签展开状态可跨刷新和工作区变化保留，深链也能显示所选行。这些偏好仍局限于浏览器 profile。由于创建 API 不返回 id，带标签会话的创建依赖观察新近成为当前项的空白会话。

## 关联

本决策扩展了[工作区标签分组与嵌套](2026-08-16-workspace-tag-grouping-and-nesting.md)，复用其右键菜单与本地元数据机制，但不取代它们。
