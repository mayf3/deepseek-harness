# @deepseek-ai/dsh-activity-local

[English](README.md) | 中文

[`dsh-activity`](../activity/README.zh.md) 观察 seam 的内存 Service Provider：`LocalActivityRegistry` 把每条记录及其有界输出环保存在进程内存中，对外只给全新快照与 chunk 副本，绝不暴露活状态。

## 保留策略

每个 activity 保留一个 offset 跨淘汰稳定的 chunk 环：丢弃头部使 `outputEarliest` 前移；单个超过存活上限的 chunk 只保留其 UTF-8 安全的尾部并打上 `gapBefore` 标记。结算时把环裁到 settled 上限，已完成的 activity 仍能展示尾巴而不占存活预算。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `retainBytes` | `262144` | 每个 activity 的存活输出保留量（UTF-8 字节）。 |
| `settledRetainBytes` | `16384` | activity 结算后的保留量。 |

## 生命周期

记录的存续期长于生产者 fiber。owner 的第一个 activity 会在 exact `Agent` scope 上挂一个清理；owner 销毁时把未结束的记录终结（`killed`、`owner disposed`）并移除，同时公告移除。服务销毁终结一切、清空存储并逐个公告被清空的 owner。两者都不等待生产者——注册表不拥有任何执行资源。监听按注册 scope 分层，与 jobs 注册表完全一致，一个进程级实例内投递保持 owner 相对。

## 模型体验

无：provider 只存储与提供观察状态；所有模型可见面都归生产者。

#### KV Cache 影响

无；本包从不组装或改动 provider 请求。

## 已知限制与暂缓事项

- **无主桶没有准入上限**——有主生产者已被 jobs 准入策略约束，但插件开出的大量无主 activity 会让存储一直增长到服务销毁。
