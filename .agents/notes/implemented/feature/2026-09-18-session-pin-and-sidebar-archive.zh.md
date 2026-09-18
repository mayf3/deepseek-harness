# Agent Note: Session pinning and the sidebar archived filter

Status: implemented

[English](2026-09-18-session-pin-and-sidebar-archive.md) | 中文

## Problem

侧边栏会话列表无法把重要会话固定在顶部，已归档会话只能通过远离列表的设置页（`ui-settings-unarchive-sessions`）访问。用户归档一个会话之后就再也看不到它了。

## Decision

`dsh-workspace` registry 在既有归档集合旁存储一个 registry 全局置顶集合（`pinnedSessions`，最近置顶在前，每项携带毫秒级 `pinnedAt`），并提供持久化的 `pinSession`/`unpinSession` 操作。置顶与归档互斥：归档会在同一次持久化写入中移除该会话的置顶，置顶已归档会话则以 `WorkspaceArchivedSessionPinError` 失败。

侧边栏在 `ui-workspace` 中派生这两种状态：

- 置顶行以分区方式排在所在区块最前，分区不打乱两侧的相对顺序，因此取消置顶会恢复行原有的位置。最近更新排序下，置顶行按置顶时间与更新时间中较晚者排名；手动排序下，置顶行之间的拖拽顺序保持。
- 已归档行保留其记账位置，置灰渲染且不可打开。视图选项菜单持有 `ArchivedFilter`（`default` 隐藏 / `show` / `only`），同时作用于列表与搜索；设置页的归档列表连同其包一并删除。
- 归档动作弹出携带撤销与筛选已归档操作的 toast，并在视图选项触发按钮下方锚定一次性提示。
- 行动画使用 `@formkit/auto-animate`，仅保留给置顶跳动与归档/取消归档淡入淡出；整体布局变化（展开/收起、拖拽提交、分组/排序/筛选切换）通过 `muteNextRowAnimations` 将行动画静默一帧。

## Alternatives considered

**保留设置页的归档列表。** 同一状态出现两个入口；侧边栏筛选让已归档行显示在它们原本所在的浏览上下文中，因此该包被整体移除。

**把置顶位置并入持久化的手动排序。** 排序会吸收置顶状态，取消置顶后无法恢复行先前的位置；分区让置顶状态与行顺序保持独立。

**用 auto-animate 默认行为为每次列表变化播放动画。** 展开分组、提交拖拽或切换筛选会整体移动行，观感夸张；这些变化即时应用，动画只保留给单行的置顶与归档变化。

## Consequences

侧边栏端到端拥有已归档可见性，设置页少了一个包。置顶集合是 registry 全局的，因此置顶在分组与排序切换后仍然保留。`ui-workspace` 新增 client 依赖 `@formkit/auto-animate`。单元测试钉住分区、筛选、toast 与静默行为；workspace Host 测试钉住置顶/归档互斥与持久化。
