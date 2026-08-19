# Agent Note: 会话投影作为必需 seam

Status: implemented

[English](2026-08-07-session-projection-mandatory-seam.md) | 中文

## 问题

可选的投影注册表会让贡献方和读取方在缺少该服务时仍然激活，并静默丢失 host 状态、客户端读模型或 subagent 目录字段。只有批量读取也会在消费方只需要一个 host 值时物化每个客户端 view。

## 决策

本决策建立在[会话投影的 host 状态与客户端视图](2026-08-19-session-projection-state-and-client-views.md)所定义的拆分之上。

每个贡献或读取投影单元的插件都把 `sessionProjections` 作为必需注入。正式组合在这些插件之前挂载注册表。`ApiProxyService` 遵循同一规则；较低层的 `createApiProxy` factory 对隔离测试和诊断保持容错。

注册表提供 `stateOf(session, key)` 来读取一个类型化 host 状态，并为批量 carrier 保留 `snapshot()`。客户端 view 只包含消费方使用的字段；host 读取方通过 `stateOf` 取得更丰富的状态。

`onChanged` 只发布客户端可见值的变化。单元注册和移除仍是绑定 effect 的注册表生命周期；它们不创建第二条 Host 事件流或客户端 tombstone 协议。后续权威 history 或 list 基线会反映活跃 key 集。

## 考虑过的替代方案

- **让注册表保持可选。** 这会保留更多不完整组合，但缺失读模型将无法与合法缺席区分。之所以否决，是因为正式 profile 已挂载注册表，且配置错误应在加载时失败。
- **每次读取都使用 `snapshot()`。** 这只保留一个方法，但会计算无关 wire view，并鼓励消费方让 host 逻辑依赖批量传输数据。改用类型化单 key 状态读取。
- **向客户端发送完整 host 值。** 这避免单独的 view 类型，但会暴露客户端不消费的来源信息和策略旋钮。改用显式裁剪的 view。
- **跨 Host 和 mux stream 广播注册表新增和移除。** 两条 stream 没有共享顺序，客户端因此需要 tombstone、缓冲帧和基线重试来协调。插件 key 变化不值得引入第二套同步协议。

## 后果

- 缺少投影组合会在插件激活期间失败。
- host 消费方避免重复的全注册表快照和日志扫描。
- 协议负载排除 host 内部字段和逐 key 水位包装；普通基线会传达活跃 key 集。
