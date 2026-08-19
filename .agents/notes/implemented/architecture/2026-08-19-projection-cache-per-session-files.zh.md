# Agent Note：投影缓存改为每会话文件

Status: implemented

[English](2026-08-19-projection-cache-per-session-files.md) | 中文

## Problem

持久投影缓存曾是单个全局 `session_projcache.json`——存储根目录下一个文件里的 `sessions` 表。每次节流检查点都会重写包含所有会话行的整个文件，写放大随会话数量增长；且一个畸形文件会让整个缓存一起失效。

## Decision

缓存改为每会话一个 `projection_cache.json`，存放在缓存自己的存储根下——`<root>/<session-id>/projection_cache.json`（session id 是代码生成的字符串，直接用作目录名）。缓存拥有自己的目录树，绝不咨询持久化层：没有 `locate`、不依赖挂载的是哪个后端。缓存服务保留其余全部职责：检查点折叠、写策略（turn/end + dispose 强制点、count/interval 节流）、fail-soft 持久化与列表读。

读取缓存行现在是一次文件读取，因此 `cachedSnapshot(meta)` 变为异步。缓存不再运行冷重折叠阶梯（那需要读取会话日志，属于持久化层的职责）；需要保证冷快照的消费方自行从日志重折叠。会话目录与缓存文件经 `@deepseek-ai/dsh-atomic-write` 以仅属主权限（`0o700`/`0o600`）创建。

## Consequences

- 每会话写入隔离：每次节流写入只替换该会话的小文件，消除全局写放大。同一缓存文件的写入被串行化，新切面绝不会先于旧切面落盘；插件释放时会排空在途写入。
- 列表读取从一次大加载变为 N 次小文件读取；没有缓存文件的会话只是缺少投影列。
- 无需迁移：缓存是派生数据，绝非权威。过时的缓存（任何更早格式）从不被读取——首次冷读从日志重折叠并写出当前格式。
- 缓存文件仍绑定同一日志生命周期：存储的 `{createdAt, cwd}` 身份防止被重建的 id 误导。

## Alternatives considered

- **保留全局 sessions 表。** 保留一次加载式列表，但保留了促成此改动的全局写放大与单文件爆炸半径。
- **经 `sessionPersistence.locate(meta)` 解析路径**（文件放在会话日志旁）。未采用：缓存得从日志 artifact 路径"猜"日志旁边（`dirname` + 固定文件名），把缓存耦合到持久化服务与后端的布局。缓存改用自有目录树。
- **在缓存内复刻会话目录布局。** 未采用：持久化后端已拥有该布局；缓存为自己派生的文件不需要日志的 project/session 目录结构。
- **使用现有 `@deepseek-ai/dsh-atomic-write`。** 采纳：它是仓库唯一的原子整文件写入原语（含仅属主权限）；从 storage-json 后端再导出一套并行实现被否决。
