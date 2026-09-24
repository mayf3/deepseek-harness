---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-21-user-question-reply

[English](2026-09-21-user-question-reply.md) | 中文

## 概述

新增受限定的 user-question-reply 消息来源，把已继续的 ask_user_question 调用的迟到回答或放弃送入 agent inbox。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-user-question-reply
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "99a3e14f0b0ff0e38d345e7cb7d8d81ee8d11c51d611d9f91b1a82c8ea481fc4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "5d588f99e950c42bdd55a27fa41e98f5c86db5b0523622d85b99604c7ddb0107"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "64170a859320a56b572372f9ab16e31c4ae9c62454a31418e900ebbf90053c68"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "1d1697092d04c08f9fcb99015ac082e58b01b7de9e41611fa6aebf2879c3d083"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有日志不含该来源，仍然有效。该类型是受限定的归属：没有 dsh-user-questions 的读取方原样保留这条用户消息及其 callId 与 outcome 元数据，仅凭消息内容推导历史。只有生产方的 userQuestions projection 读取该类型，用来关闭它指名的问题；它不施加任何校验、回放或权限要求。不新增事件类型，Session header 不变。

<a id="verification"></a>
## 验证

pnpm run typecheck：Host 与 Client 两个 face 通过。pnpm --silent run verify-persistence-changes --json：四个受影响的根均判为 attribution-kind-added，无需版本升级。projection 与 Remote 的行为测试待补。

<a id="dev-note"></a>
## 开发备注

无。
