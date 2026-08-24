# @deepseek-ai/dsh-activity

[English](README.md) | 中文

流式输出观察契约（`ctx.activities`）。抽象 `ActivityRegistry` 与其词汇类型给所有长时生产者一个发布实时输出与状态的位置，并让任意数量的独立消费者对其做非消费读取；内存实现在 [`dsh-activity-local`](../activity-local/README.zh.md)。生产者插件通过 `ActivityKindMap` 扩展自己的不透明 id 命名空间，并可经 `ActivityCorrelation` 把 activity 关联到它的工具调用与后台 job。

注册表是纯观察面：不启动、不取消任何工作，对模型不可见。生产者保留自己的执行资源与既有模型面；不装本 seam 的组合只失去实时观察。

## 服务契约

- `open(spec): ActivityHandle` 校验 kind、label 与 exact 存活 owner 后原子注册记录并返回生产者句柄：同步的 `append(text, { channel?, gapBefore? })`、`updateDetail(detail)` 与 first-wins 的 `end(outcome)`。`end` 之后——包括 teardown 强制 end——`append` 与 `updateDetail` 记日志后丢弃而不抛错，生产者的收尾 flush 不会砸掉自己的 teardown。
- `get(id, caller?)` 与 `list(caller?)` 返回全新快照。列表只含调用方拥有与无主的 activity；有主访问比较 activity 的 `SessionId` 与调用方的，id 可预测，这道栅栏即边界。
- `read(id, from, caller?)` 返回与 `[from, total)` 重叠的保留 chunk 及续读 offset，绝不消费。offset 是跨淘汰稳定的绝对 UTF-8 字节位置；落后于最老保留字节的读者得到 `lossy: true`，永不报错。
- `onActivitiesChanged(listener)` 观察可见集变化——开启、detail 更新、结算、owner 销毁移除、服务销毁清空——消费者整读而非累积增量。`onOutput(listener)` 发出流推进信号（每次提交的 append 一发、结算再一发），只携带 id；消费者按自己的游标去 read。两者按 jobs 注册表的条款做 owner 相对投递，且每个监听都被容错。

`pumpActivityOutput(handle, sources, { pollMs, done })` 是给非消费 offset 读取器型底座（subprocess 的 `readFrom(fromByte)` 家族）的共享泵：按有界节奏复制带标签的增量、把 lossy 的源读取标为 `gapBefore`、在 `done` 结算后再排干一次，且自己绝不调用 `end()`。

参见 [activity 子系统页](../../../docs/subsystems/activity.zh.md)与[观察 seam Agent Note](../../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.zh.md)。

## 模型体验

无：注册表只承载面向人的实时观察状态，不注册任何 prompt、工具或会话事件；activity 输出只有经生产者既有的工具结果与 `ctx.jobs` 读取才对模型可见。

#### KV Cache 影响

无；本包从不组装或改动 provider 请求。

## 已知限制与暂缓事项

- **记录是进程本地且仅存活期有效**——Host 重启清空全部 roster，而 transcript 侧的生产工具卡片仍在；持久回放是独立设计。
- **观察面没有取消动词**——停止工作仍属于生产者与 `ctx.jobs`；面板发起的 kill 被 [web job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.zh.md) 记录的 jobs `reported` 契约问题阻塞。
- **已结算记录保留到 owner 销毁**——保留策略把缓冲裁到 settled 上限，但行本身不会老化清除。
