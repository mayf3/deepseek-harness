# Agent Note: 连接指示器状态与交互细化

Status: implemented

[English](2026-09-10-connection-indicator-refinements.md) | 中文

## Problem

侧边栏连接药丸把操作提示藏在悬停切换里：断连与重试状态在悬停或聚焦时把文案替换为**立即重连**，因此每个状态都要为最宽的 label 预留空间以避免控件变形。一次不到一秒就恢复的重试会让连接中药丸闪现闪没，手动点击与自动退避读起来毫无区别，状态切换和消失也没有任何过渡、十分突兀。

## Decision

**断连药丸静态地指明其动作。** [ConnectionIndicator.tsx](../../../../packages/client/ui-primitives/src/ConnectionIndicator.tsx) 在断连文案旁渲染重试图形（`IconRefreshOutline14`），文案本身即指明重试动作（`连接异常，刷新重试` / `Disconnected`）；点击药丸仍会立即重连。悬停换文案和隐藏的最宽 label 占位 span 全部移除，药丸宽度随当前 label 自适应。连接中状态改用旋转圆弧 spinner 取代感叹号图形。出现、状态切换与消失均以 150ms 淡入淡出：`EXIT_MS` 延迟卸载以匹配样式表的 `.leaving` 过渡，`prefers-reduced-motion` 会禁用全部动画与过渡。外观定为高 28px、水平内边距 8px、图标间距 4px、圆角 13px，以及 label 颜色 20% 透明度的 1px 边框。

**外壳拥有尝试节奏与尝试命名。** [SettingsRoot.tsx](../../../../packages/client/ui-settings-general/src/client/SettingsRoot.tsx) 让连接中药丸至少可见 `CONNECTING_MIN_VISIBLE_MS`（800ms），亚秒级重试不再闪动；并跟踪由药丸点击置位的 `manualRetry` 标志，用户主动发起的尝试显示`重新连接中`（`connection.reconnecting`），自动退避显示`自动重连中`（`connection.connecting`）。两个时长与恢复确认既有的 2 秒一样，是各自持有方的内置展示常量，不是配置。

## Alternatives considered

**给宽度变化加动画。** FLIP 式的像素测量过渡（记住旧宽度、钉住、过渡到新测量值）实现后又被移除：纯淡入淡出已足够平静，而测量重放为边际的打磨引入了一个 layout effect 和命令式样式写入。

**悬停时切换为重试图形。** 悬停时从警告图形 80ms 交叉渐变到重试图形的方案实现后又被简化掉：常驻显示重试图形无需任何指针交互就说明了操作，与静态文案的决定一致。

**进出场缩放。** 淡入淡出最初伴随 0.98 的缩放；在 12px 文字上这点位移读起来像抖动，因此只保留透明度。

## Consequences

`ConnectionIndicator` 的 `reconnectLabel` prop 及其占位 span 从 pre-stable API 中移除；唯一消费者（`ui-settings-general`）在同一变更中更新。`settings-root.client.spec.tsx` 固定 800ms 驻留、手动与自动命名以及淡出延迟；`atoms.client.spec.tsx` 固定退出时长后的卸载。两个包的 README 重述了该交互。
