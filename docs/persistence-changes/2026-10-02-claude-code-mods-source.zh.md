---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-02-claude-code-mods-source

[English](2026-10-02-claude-code-mods-source.md) | 中文

## 概述

新增仅用于归因的 `claude-code-mods` user 消息来源种类，用于 Claude Code 模组通过 `prompt.submit` 添加的上下文以及通过 `$.prompt.submit` 提交的提示词。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-claude-code-mods-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "f4654f14522a5b84ae84e2d80959ea596c0684d04ca315bde3705261065a929c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "e4b8ca6005c0b20db2b7b9db5f1a46b2d5fb9ff1f6bad61c241512519bce8321"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "5163154425bd5e0d6b2617b7d3d9816ee04bd237a030decbbececac66a36c510"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "83e827b9ea6b4d7309bcf7f1f97040f4750d4ddaf5f19bf18e4cde7605c7e628"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。读取方在没有该生产者时也会保留 `claude-code-mods` 来源的消息；没有读取方依据该种类做校验、回放或授权，消息文本本身已指明模组。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/claude-code-mods/tests：88 个测试通过，包括 bridge.spec.ts 中对提示词上下文与提交提示词来源的断言。

<a id="dev-note"></a>
## 开发备注

无。
