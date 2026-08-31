# Agent Note: 实时 assistant 流帧与 Session log 保持分离

Status: implemented

[English](2026-08-31-live-assistant-stream-frames.md) | 中文

## 问题

Session log 保留每个 `assistant/chunk`，因此重放、冷读、遥测和请求重建都能观察同一份持久 v1 历史。实时消费方还需要在请求运行时逐帧呈现。把短暂的呈现更新当作新的持久事件会改变持久化语义，并让只属于进程生命周期的事实跨重启保留。

## 决定

`dsh-agent-loop` 为每次模型尝试发出作用域内的 `agent/assistant-stream` 帧。`start`、`chunk` 和 `end` 带有带品牌的进程本地 `LlmAttemptId`；每个已发出的帧都会推进一次 Session 本地 revision。`start` 帧会把壁钟时间捕获为安全整数 `startedTime`，chunk index 从零开始连续递增，`end.index` 等于下一个 chunk 位置。循环在匹配的实时 chunk 帧之前追加每个 v1 `assistant/chunk`，记录精确的 `legacyChunkSeq`，并在已提交的 end 帧之前追加最终 `assistant/message`。现有的已认证 Session-follow 接受显式 Web opt-in，以缓存的活跃尝试 baseline 打开，并在一个 FIFO 中携带持久事件和无 cursor 的帧。每个 follower 会随 opening baseline 捕获本地到达序号，并丢弃该 cut 及之前的 buffered frame；replacement Agent 的 frame revision 可以从一重新开始，因此 revision 不定义 opening cut。当 opening 位于最终持久 message 与对应 end 帧之间时，Web Session 会公开活跃 chunk，只暂存 ordered legacy seq 来源完全相同的最终 message，并在匹配的 `end.index` 到达后释放；同一 Turn 和 Step 中更早的 retry 仍保持可见。revision、连续 index 或来源缺口会重新打开 follow 并替换 baseline。TypeScript 和 Python SDK 协议不公开这些帧。持久 log 仍然是重放和模型历史的真源。

## 曾考虑的替代方案

- **用仅实时的流替换 `assistant/chunk`**：不采用，因为冷读、重放、遥测和已完成 assistant message 的来源引用都需要持久的原始 chunk 历史。
- **添加持久的 assistant-stream 事件类型**：不采用，因为进程本地尝试、revision 和重连呈现不是会跨重启保留或影响模型重建的事实。
- **用未加品牌的请求字符串作为尝试键**：不采用，因为消费方需要一个不透明身份，不能把它与 provider request ID 或持久 Session ID 混淆。
- **让 UI Chat 订阅第二个实时 source**：不采用，因为 Session 对象拥有 stream 对账，UI Conversation 是唯一的 event-source 订阅方；第二个 source 会使结算顺序依赖 target。

## 影响

Web client 可以在 persistence flush 前渲染内存 chunk，同时保留一份持久 v1 历史，而不改变 `SESSION_FORMAT_VERSION` 或 chunk-row 编码。进程重启后没有活跃 assistant 帧；重连和冷重放使用持久记录。无 cursor 的通知绝不推进 journal cursor，在持久缺口修复期间观察到的通知会等待 replacement page。帧声明保持 agent 作用域，因此监听器只观察所属 Agent，除非它显式全局注册。
