# Agent Note: Workspace browser tag grouping, waiting-on nesting, and row context menus

Status: implemented

## 问题

左侧工作区浏览器（ui-workspace）只按 Host Workspace 分组：会话按目录归类，跨目录的组织（标签）只能靠会话标题命名，任务之间的依赖关系（「这个任务在等那个任务」）没有表达方式，行操作也只有一个不明显的省略号按钮。产品需要：任务可配置标签并按标签分组；任务可挂到另一个任务下表示等待关系；行操作能通过右键直达。

## 决策

**标签与等待关系是浏览器本地元数据，不写进会话日志。** `WorkspaceViewState` 增加 `sessionMeta: Record<sessionId, { tags?: string[]; parent?: string }>` 与 `knownTags: string[]`（显式创建的空标签组），随既有 `persist` 键自动持久化。标签分组（`deriveTagGroups`）只读用户元数据；模型通过 `todo_write` 写入 todo 的 `tags` 不参与分组，避免模型噪音污染侧栏。等待关系通过 `waitingOrder` 把子会话排到父会话之后并嵌套（`SessionNode.depth`），环由未放置成员兜底断开。

**挂接与打标签都有拖拽与菜单两条路径。** 会话行拖拽的中间区域（行的 30%–70%）表示「挂到该任务下」，上下边缘保留排序语义；把嵌套行拖到行间即脱离父任务。标签视图下拖到标签组标题 = 打标签，拖到「未打标」桶 = 清空标签；`ProjectRowItem` 接收 `dropTarget` 并高亮。菜单保留「设置标签…」入口，去掉选择器式「挂到任务下」（拖拽已覆盖）。

**右键菜单。** 会话行与工作区行都响应 `onContextMenu`（阻止默认菜单）打开同一行菜单；会话行菜单新增「在此目录新建会话」（仅目录视图，标签视图无工作区概念）。

**`todo_write` 支持可选 `tags`。** `TodoItem` 增加 `tags?: string[]`，工具 schema/描述/投影同步更新，规范化（trim、去空、去重、限 8 个、每个 32 字符）；数据层保留供未来使用，UI 当前不展示。

## 曾考虑的替代方案

**把标签写入会话日志（`TodoItem.tags` 进入事件）。** 不采用：模型会主动写标签产生噪音（实测 check/setup/tests），且前端无法安全地 append 会话事件；浏览器本地元数据已满足「用户主动配置」的需求且零 Host 改动。

**把「挂到任务下」做成目录式嵌套视图。** 不采用：拖拽中间区域 + 组内嵌套是既有行模型的最小扩展；独立树视图需要新的渲染骨架。
