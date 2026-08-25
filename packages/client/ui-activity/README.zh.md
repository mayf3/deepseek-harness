# @deepseek-ai/dsh-client-ui-activity

[English](README.md) | 中文

会话头部任务列表：一个头部 action 渲染本会话的后台任务与其关联的实时输出 activity 的合并视图，外加 workflow 运行等独立 activity。合并逐行发生在本组件内——jobs 与 activity 仍是两个独立的面（[缘由](../../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.zh.md)）：job 行保留来自 `jobsBySession` 镜像的生命周期、时长与模型可见 `detail`，当某个 activity 以 `correlation.jobId` 关联到它时获得可展开的输出面板；没有 job 的 activity 保留自己的行。进行中的行以命令为主行、kind 与状态为副行并带跳动时长；已结束的行折为降权单行，置于分节线之后。

展开可观察的行即把该 activity 在 `ctx.activityFeed` 上的观察流打开进内嵌终端面板。观察跟随可见性——展开开流，收起、卸载或关闭弹层即停流，只有有人在看时输出才流动。保留缺口与流失败以面板上方的提示呈现。

会话一个任务都看不到时该控件完全不渲染，普通会话不会为未使用的能力多出控件。没有 activity 注册表时，job 行仍从会话镜像渲染——只是不提供输出面板。

## 模型体验

无：本包只为人渲染宿主观察到的状态与实时输出，不触碰任何 prompt、消息、schema、流或工具结果。模型对同一工作的视图仍在 [`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md)。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与暂缓事项

- **没有 kill 控件**——取消仍走模型的 `job_kill`；人工 kill 被 [web job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.zh.md) 记录的 jobs `reported` 契约问题阻塞。
- **不渲染通道标签**——stdout 与 stderr chunk 连接成一条流；分通道着色是后续呈现优化。
