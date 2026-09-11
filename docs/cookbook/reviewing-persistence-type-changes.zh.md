---
description: "在创建 PR 前，本地生成、确认并验证会话持久化类型变更。"
---

# 实操手册：审阅持久化类型变更

[English](reviewing-persistence-type-changes.md) | 中文

## 概述

在已安装依赖的贡献者检出目录中修改会话持久化类型声明后，使用本教程。你将检查结构差异、记录兼容性决策，并在本地运行与 CI 相同的检查。[记录参考](../persistence-changes/README.zh.md)解释文件和自动规则。所有比较输入都在检出目录中；不需要基线分支或网络访问。

## 目录

- [1. 生成当前清单](#generate)
- [2. 创建确认记录](#acknowledge)
- [3. 说明并验证变更](#verify)
- [4. 解决竞争记录](#competing-records)
- [开发备注](#dev-note)

-----

<a id="generate"></a>
## 1. 生成当前清单

编辑类型及其消费方后，在仓库根目录运行：

```sh
pnpm run gen-persistence-catalog
pnpm run verify-persistence-changes
```

审阅生成的[目录](../persistence-catalog.zh.md)和 [schema 清单](../persistence-schema.json)。嵌套引用类型可能影响多个事件摘要；检查所有报告的根。重新生成不等于确认变更。在历史覆盖新 schema 之前，验证会报告变更路径并失败。

<a id="acknowledge"></a>
## 2. 创建确认记录

根据[兼容性规则](../persistence-changes/README.zh.md#compatibility-rules)选择决策。对于可选事件体新增，用日期和描述性短名替换示例 id：

```sh
pnpm run persistence-changes --record 2026-09-11-optional-display-metadata --decision same-version
```

命令在 [persistence-changes](../persistence-changes/README.zh.md) 中创建英文和中文记录草稿，以及生成的 schema 伴随文件。每个受影响的根引用其最新记录前驱。变更后 schema 和摘要来自源码；不要手工编辑。

对于需要升版本的变更，先遵循[添加会话格式版本](adding-a-session-format-version.zh.md)，再使用 `--decision version-bump`。记录必须包含其自身的 `SessionHeader.version` 递增转换。无关的历史升版本不能授权本次变更。不要为日常变更创建另一条基线。

<a id="verify"></a>
## 3. 说明并验证变更

替换两种语言中生成的兼容性和验证占位内容。保持机器声明相同。仅解释报告的类型变更，并记录实际运行的聚焦测试结果。对于可选新增，审阅旧记录能否缺少该数据，以及旧读取器能否忽略它而不改变回放；自动分类不能证明该说明。

根据生成的英文变更更新目录的中文对侧文件。确认两个双语对，然后验证：

```sh
pnpm run verify-translation-pairing --write docs/persistence-catalog.md
pnpm run verify-translation-pairing --write docs/persistence-changes/2026-09-11-optional-display-metadata.md
pnpm run verify-persistence-catalog
pnpm run verify-persistence-changes
```

在配对命令中使用实际记录 id。当生成文件与源码一致、每次转换满足其分类要求、每个当前根与最终历史状态一致时，验证通过。在 PR（Pull Request）中包含生成文件、记录对和两个一致性伴随记录。运行由变更代码决定的其他检查；本检查不能替代行为测试或迁移验证。

<a id="competing-records"></a>
## 4. 解决竞争记录

集成时若报告一个根的前驱有两个后继，保留已接受记录，并使用新 id 在其基础上重新创建尚未接受的记录。重新评估最终组合的类型变更并重跑检查。无关根的记录无需刷新。

若生成草稿后源码再次变化，只丢弃该未接受草稿及其伴随文件，重新生成清单，再创建替代记录。保留已接受历史。后续类型编辑不能沿用对另一摘要的确认。[机制决策](../../.agents/notes/implemented/process/2026-09-11-persistence-type-history.zh.md)解释为何保留完整快照和逐根前驱。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
