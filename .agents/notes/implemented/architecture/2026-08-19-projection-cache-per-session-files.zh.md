# Agent Note：投影缓存改为每会话文件

Status: implemented

[English](2026-08-19-projection-cache-per-session-files.md) | 中文

## Problem

持久投影缓存曾是单个全局 `session_projcache.json`——存储根目录下一个文件里的 `sessions` 表。每次节流检查点都会重写包含所有会话行的整个文件，写放大随会话数量增长；且一个畸形文件会让整个缓存一起失效。

## Decision

缓存改为每会话一个 `projection_cache.json`，存放在该会话自己的持久化目录内。位置来自持久化 seam——`sessionPersistence.locate(meta)`——因此会话目录布局由持久化后端所有（jsonl 后端将其放在会话日志旁）；缓存服务绝不 import 后端的路径 helper。缓存服务保留其余全部职责：检查点折叠、写策略（turn/end + dispose 强制点、count/interval 节流）、fail-soft 持久化与冷读阶梯。

读取缓存行现在是一次文件读取，因此 `cachedSnapshot(meta)` 变为异步；`coldSnapshot` 改为接收会话 header（定位文件需要 header——存储日志的 header 仍是身份见证）。没有每会话目录的持久化后端（如 sqlite）会禁用持久缓存：写入变为 no-op，冷读落到全量日志那一级。

## Consequences

- 每会话写入隔离：每次节流写入只替换该会话的小文件，消除全局写放大。
- 列表读取从一次大加载变为 N 次小文件读取；没有缓存文件的会话只是缺少投影列。
- 无需迁移：缓存是派生数据，绝非权威。过时的全局缓存（或任何更早格式）从不被读取——首次冷读从日志重折叠并写出当前格式。
- 缓存文件仍绑定同一日志生命周期：存储的 `{createdAt, cwd}` 身份防止被重建的 id 或替换的存储误导。

## Alternatives considered

- **保留全局 sessions 表。** 保留一次加载式列表与同步 `cachedSnapshot`，但保留了促成此改动的全局写放大与单文件爆炸半径。
- **存储根目录下每会话一个 storage-domain unit**（扁平 `session_projcache_<id>.json`）。未采用：unit 名必须匹配 `[a-z0-9_]`（会话 id 做不到），且文件会落在会话目录之外，散落在存储根目录而不是日志旁。
- **在缓存内复刻会话目录布局。** 未采用：持久化后端已通过 `locate` 拥有该布局；复刻路径 helper 会把缓存耦合到后端的内部实现。
