# Agent Note: 实时 assistant 流帧与 Session log 保持分离

Status: implemented

[English](2026-08-31-live-assistant-stream-frames.md) | 中文

## 问题

Session log 保留每个 `assistant/chunk`，因此重放、冷读、遥测和请求重建都能观察同一份持久 v1 历史。实时消费方还需要在请求运行时逐帧呈现。把短暂的呈现更新当作新的持久事件会改变持久化语义，并让只属于进程生命周期的事实跨重启保留。

## 决定

`dsh-agent-loop` 为每次模型尝试发出作用域内的 `agent/assistant-stream` 帧。`start`、`chunk` 和 `end` 带有在单个 Agent lifecycle 内唯一的 branded `LlmAttemptId`；每个已发出的帧都会推进一次该 lifecycle 本地 revision。`start` 帧给出该尝试的 turn 与 step，chunk index 从零开始连续递增，`end.index` 等于下一个 chunk 位置。循环会先取得 stream 并执行最终取消检查，再发出 `start`；这些步骤失败时不发出任何帧，而每个已开始的尝试都会发出终态 `end`。循环在匹配的实时 chunk 帧之前追加每个 v1 `assistant/chunk`，记录精确的 `legacyChunkSeq`，并在已提交的 end 帧之前追加最终 `assistant/message`。现有的已认证 Session-follow 接受显式 Web opt-in，以缓存的活跃尝试 baseline 打开，并在一个 FIFO 中携带持久事件和无 cursor 的帧。每个 follower 会随 opening baseline 捕获本地到达序号，并丢弃该 cut 及之前的 buffered frame；replacement Agent 的 frame revision 可以从一重新开始，因此 revision 不定义 opening cut。如果持久 opening snapshot 早于 Assistant baseline，baseline 可能已经确认一个持久事件仍在 buffer 中的 chunk；该事件到达时，Web Session 会依据 baseline 中精确的 `legacyChunkSeq` 已证明其匹配帧而直接发布。活跃 opening 之后到达的最终 message 会保持暂存，直到匹配的 `end.index` 与有序来源到达；同一 Turn 和 Step 中更早的 retry 仍保持可见。已知 attempt 的 revision、连续 index 或来源缺口会重新打开 follow 并替换 baseline；unknown attempt 使用持久回退。TypeScript 和 Python SDK 协议不公开这些帧。持久 log 仍然是重放和模型历史的真源。

## 曾考虑的替代方案

- **用仅实时的流替换 `assistant/chunk`**：不采用，因为冷读、重放、遥测和已完成 assistant message 的来源引用都需要持久的原始 chunk 历史。
- **添加持久的 assistant-stream 事件类型**：不采用，因为进程本地尝试、revision 和重连呈现不是会跨重启保留或影响模型重建的事实。
- **用未加品牌的请求字符串作为尝试键**：不采用，因为消费方需要一个不透明身份，不能把它与 provider request ID 或持久 Session ID 混淆。
- **让 UI Chat 订阅第二个实时 source**：不采用，因为 Session 对象拥有 stream 对账，UI Conversation 是唯一的 event-source 订阅方；第二个 source 会使结算顺序依赖 target。

## 影响

Assistant 帧会门控并结算持久事件的发布，而不改变 `SESSION_FORMAT_VERSION`、chunk-row 编码或用户可见的渲染来源。进程重启后没有活跃 assistant 帧；重连和冷重放使用持久记录。在 attempt start 之后才加入的 Client 无法重建该瞬态 attempt，因此 unknown-attempt 帧会回退到普通持久发布，直到下一个已知 start。无 cursor 的通知绝不推进 journal cursor，在持久缺口修复期间观察到的通知会等待 replacement page。该 page 不携带 Assistant baseline，因此 Client 会清空瞬态尝试，并让 held notification 重新打开 follow 一次，以取得原子配对的 page 与 baseline。帧声明保持 agent 作用域，因此监听器只观察所属 Agent，除非它显式全局注册。
