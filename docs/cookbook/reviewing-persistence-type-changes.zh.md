---
description: "在创建 PR 前，本地生成、确认并验证会话持久化类型变更。"
---

# 实操手册：审阅持久化类型变更

[English](reviewing-persistence-type-changes.md) | 中文

## 概述

在已安装依赖的贡献者检出目录中修改会话持久化类型声明后，使用本教程。你将检查结构差异、提供双语兼容性说明，并在本地运行与 CI 相同的检查。[记录参考](../persistence-changes/README.zh.md)解释文件和自动规则。所有比较输入都在检出目录中；不需要基线分支或网络访问。

## 目录

- [1. 检查变更](#generate)
- [2. 提供说明并创建记录](#acknowledge)
- [3. 验证结果](#verify)
- [4. 更新尚未接受的记录](#competing-records)
- [开发备注](#dev-note)

-----

<a id="generate"></a>
## 1. 检查变更

编辑类型及其消费方后，在仓库根目录运行：

```sh
pnpm --silent run verify-persistence-changes --json
```

阅读报告中的根、路径、变更种类和版本要求。被引用类型可能影响多个事件摘要；检查每个受影响的根。在历史覆盖新 schema 之前，验证会失败。陈旧生成清单也会导致验证失败；记录命令会刷新它。若只改变展示细节且 `changes` 为空，运行 `pnpm run gen-persistence-catalog`；无需新增确认记录。

<a id="acknowledge"></a>
## 2. 提供说明并创建记录

根据[兼容性规则](../persistence-changes/README.zh.md#compatibility-rules)选择决策。编写包含 `en` 和 `zh` 的本地 JSON 文件，两者分别包含 `summary`、`compatibility` 和 `verification` 字符串。以下输入描述一个经过验证的钩子审计字段从必选改为可选的变更。用你所做变更的事实替换说明和测试证据；CLI（命令行界面）不会证明这些声明。

将输入保存为 `.artifacts/persistence-change.prose.json`，必要时创建该被忽略的目录：

```json
{
  "en": {
    "summary": "Makes the persisted hook audit decision optional.",
    "compatibility": "Existing records remain valid. Hook execution consumes HookOutput instead of replaying this audit field. Producers still write decisions, and absence does not imply pass.",
    "verification": "pnpm exec vitest run packages/hooks/hook-protocol/tests/events.spec.ts: 10 tests passed."
  },
  "zh": {
    "summary": "将持久化的钩子审计决策改为可选。",
    "compatibility": "已有记录仍然有效。钩子执行消费 HookOutput，不回放此审计字段。写入方仍然记录决策，缺失不代表 pass。",
    "verification": "pnpm exec vitest run packages/hooks/hook-protocol/tests/events.spec.ts：10 个测试通过。"
  }
}
```

用日期和描述性短名替换示例 id：

```sh
pnpm --silent run persistence-changes --record 2026-09-11-poc-optional --decision same-version --prose .artifacts/persistence-change.prose.json --json
```

命令创建记录对和完整的变更后 schema，更新两份生成目录与机器清单，并记录双语配对。提交 `files` 中列出的文件前，审阅人工说明和生成差异。说明输入是编写用文件；生成的文档保留说明内容。省略 `--prose` 会创建未完成草稿，验证将拒绝它们，直到说明补齐。

对于需要升版本的变更，先遵循[添加会话格式版本](adding-a-session-format-version.zh.md)，再使用 `--decision version-bump`。记录必须包含其自身的 `SessionHeader.version` 递增转换。无关的历史升版本不能授权本次变更。日常变更不创建另一条基线。

<a id="verify"></a>
## 3. 验证结果

本地与 CI 运行相同检查：

```sh
pnpm --silent run verify-persistence-changes --json
```

生成清单与源码一致、每次转换满足其分类要求、当前根与最终历史状态一致时，成功响应报告 `ok: true`。失败响应报告 `ok: false`，退出码为 1；JSON 可解析不代表成功。响应包含 `operation`、`message`、结构化 `changes`、`roots` 中逐根的变更前后摘要、生成的 `files`，以及适用时的失败 `code`。每个变更都有稳定的 `kind`；自动化不需要解析描述文本。

运行由变更代码决定的其他检查，包括配套人工文档的检查。记录生成负责其目录和记录的双语对；包 README 或其他双语页面的编辑仍遵循常规配对流程。持久化类型检查不能替代行为测试或迁移验证。

<a id="competing-records"></a>
## 4. 更新尚未接受的记录

记录后源码再次变化时，审阅兼容性说明，并刷新同一条尚未接受的末端记录：

```sh
pnpm --silent run persistence-changes --update 2026-09-11-poc-optional --decision same-version --prose .artifacts/persistence-change.prose.json --json
```

命令刷新机器声明、schema、目录和配对。没有 `--prose` 时，它保留已有说明。更新会拒绝初始基线和被其他记录依赖的记录。目录本身无法识别哪些记录已获审阅接受：保留已接受历史，并创建后继。

集成产生竞争末端记录时，根据剩余历史更新尚未接受的记录，再重新评估最终差异。无关根的确认无需刷新。[机制决策](../../.agents/notes/implemented/process/2026-09-11-persistence-type-history.zh.md)解释为何保留完整快照和逐根前驱。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
