# @deepseek-ai/dsh-client-ui-activity

[English](README.md) | 中文

架在 `ctx.activityFeed` 上的会话头部实时活动列表：在后台任务列表旁提供一个头部 action，渲染本会话可见的 roster 行（有主 + 无主），展开某行即把该 activity 的观察流打开进内嵌终端面板。观察跟随可见性——展开开流，收起、卸载或关闭弹层即停流，只有有人在看时输出才流动。保留缺口与流失败以面板上方的提示呈现。

会话一个 activity 都看不到时该控件完全不渲染，普通会话不会为未使用的能力多出控件；没有 activity 注册表时 roster 恒空，入口永不出现。

## 模型体验

无：本包只为人渲染宿主观察到的实时输出，不触碰任何 prompt、消息、schema、流或工具结果。模型对同一工作的视图仍在 [`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md)。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与暂缓事项

- **没有 kill 控件**——取消仍走模型的 `job_kill`；人工 kill 被 [web job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.zh.md) 记录的 jobs `reported` 契约问题阻塞。
- **不渲染通道标签**——stdout 与 stderr chunk 连接成一条流；分通道着色是后续呈现优化。
- **后台 job 会同时出现在两个头部列表**——job 列表承载控制侧状态，本列表承载输出；这一重复沿用 subagent catalog 的既有取舍。
