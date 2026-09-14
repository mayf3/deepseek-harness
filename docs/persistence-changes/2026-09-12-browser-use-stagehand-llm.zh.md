---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-12-browser-use-stagehand-llm

[English](2026-09-12-browser-use-stagehand-llm.md) | 中文

## 概述

新增两个仅记录日志的 Session 事件，记录 Stagehand 辅助模型请求与完整模型输出，不改变 Session 格式版本。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-12-browser-use-stagehand-llm
baseline: false
changes:
  - root: "event:browser-use/stagehand-llm-request"
    previous: null
    after: "92cda1e2c0e9f57fdcd167a861b1296ec4cb5ac3ae127733c375e108335b32ac"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-result"
    previous: null
    after: "0e0e81784bc85e1e6554b7ff50ab341169a1a3d32149ae49abe8dddca5ce6efe"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 Session 记录仍然有效，因为它们不要求任何一个新事件。这些事件不添加对话消息，也不在重放时恢复浏览器状态。它们保留发送给选定 Session 模型的请求及其关联输出。写入方不设置 ignorable，因此不知道这些事件名称的旧构建会拒绝该 Session，而不是静默丢弃推理记录。任何已有载荷、头部、封装或已提交格式代均不改变。

<a id="verification"></a>
## 验证

`pnpm run gen-persistence-catalog` 重新生成了已安装事件目录与两种语言的持久化目录。`pnpm --silent run verify-persistence-changes --json` 只报告两个 root-added 变化，且 requiresVersionBump 均为 false。`pnpm exec vitest run packages/experimental/browser-use-stagehand-native/tests/model.spec.ts packages/experimental/browser-use-stagehand-native/tests/provider.spec.ts packages/experimental/browser-use-stagehand-native/tests/loader-composition.spec.ts` 通过，包括请求/结果日志记录与真实 Loader 组合。

`pnpm run test:snapshot snapshots/sdk/sdk.snapshot.ts snapshots/session/headless.snapshot.ts -t browser-use-stagehand-native` 的两个真实提供方录制场景均通过。Python SDK 的 `sdk-snapshot` 冒烟测试通过构建后的 `dsh` 可执行文件运行成功；其投影夹具重新发出录制的辅助载荷，并检查运行事件、订阅和持久化中的完整保留，包括请求序号关联及不进入模型可见消息的性质。

<a id="dev-note"></a>
## 开发备注

无。
