# activity/ — 流式输出观察能力族

[English](README.md) | 中文

本能力族为所有长时生产者提供统一的非消费观察面：一个 activity 是一条 append-only 的有界输出流加实时状态，任意数量的独立观察者按绝对字节 offset 读取，而模型侧路径（`ctx.jobs` 游标、工具结果）完全不受影响。

| 包 | 角色 | ctx key |
|---|---|---|
| [`activity/`](activity/README.zh.md) | 定义观察注册表与词汇 | `ctx.activities` |
| [`activity-local/`](activity-local/README.zh.md) | 实现内存环形缓冲注册表 | 注册到 `ctx.activities` |

Web 传输与客户端消费者在 [`dsh-api-activity-controller`](../api/activity-controller/README.zh.md) 与 [`dsh-client-ui-activity`](../client/ui-activity/README.zh.md)；后台 bash/pwsh 与 workflow 工具是已接入的生产者。

子系统参考——offset、保留策略、监听投递——见 [docs/subsystems/activity.zh.md](../../docs/subsystems/activity.zh.md)；设计见 [activity 观察 seam](../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.zh.md) Agent Note。
