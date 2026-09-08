# 自动请求代码评审

[English](README.md) | 中文

## 概要

[`request-review` workflow](../workflows/request-review.yml) 从受信任的默认分支读取兼容 CODEOWNERS 格式的[所有权映射](CODEOWNERS)。它会对变更文件分类，为可评审代码请求尚未加入的 owner，并在 PR 转为草稿时取消自己尚未完成的请求。所有权映射不在 GitHub 原生 CODEOWNERS 路径中，因此 GitHub 不会直接应用它。

## 目录

- [路由](#routing)
- [评审排除规则](#review-exclusions)
- [安全性](#security)
- [验证](#verification)
- [开发说明](#dev-note)

<a id="routing"></a>

## 路由

PR 在创建、同步、重新打开、标记为可评审或转为草稿时运行该 workflow。扫描器获取完整的 PR 文件列表，分别检查重命名前后的路径；如果只能取得部分列表，则停止执行，不发出评审请求。GitHub 对此 API 最多公开 3,000 个文件。

对于非草稿 PR，workflow 会请求尚未加入的匹配 owner。对于草稿，workflow 会读取当前评审请求和评审请求时间线，然后取消最近一次请求者为 `github-actions[bot]` 的当前请求。由人员发出的当前请求保持不变。如果时间线超过 3,000 个事件或包含无效的请求来源，workflow 会失败且不执行取消操作。

所有权映射只接受显式绝对目录模式和 GitHub 个人用户。通配符、隐藏目录模式、团队，以及重复的模式或 owner 都会被拒绝。匹配遵循 CODEOWNERS 的最后一条匹配规则。扫描器会在修改评审请求前，打印变更代码文件、排除的测试文件、文档文件和纯注释文件，逐文件 owner 匹配结果，以及将要请求或取消的评审者。未匹配的文件仍显示在日志中。PR 作者和已经收到评审请求的用户不会收到新请求。

策略测试会统计已匹配目录下的非测试跟踪文件行数，并要求 `@turtle1999` 拥有的有效代码库不超过三分之一。

<a id="review-exclusions"></a>

## 评审排除规则

评审路由会排除仓库中的单元测试、端到端测试、预期输出、快照、基准测试、性能测试、压力测试、语料测试、原生测试和 Python 测试约定。其中包括 `test`、`tests`、`__tests__`、`__snapshots__`、`benches` 和 `stress-tests` 目录，顶层 `benchmarks` 和 `snapshots` 目录树，`packages/test-support`、`scripts/fixtures` 和 `scripts/snapshots`，可识别的测试文件名后缀，以及 Python 的 `test_*.py` 或 `*_test.py` 文件。

能够改变证据生成方式的测试基础设施仍需评审，包括 `vitest*.config.ts` 和 `scripts` 下的门禁实现。生产文件不会仅因名称为 `test.ts`、`spec.ts` 或 `snapshot.ts` 而被排除。

扩展名以不区分大小写方式匹配。所有以 `.md` 或 `.yaml` 结尾的文件均视为文档，不会贡献 owner；除非符合其他排除规则，否则 `.yml` 文件仍需评审。

对于具有受支持源码扩展名的修改文件，扫描器会移除解析出的注释，再比较变更前后的文本。只有 GitHub 提供的 patch 中增删行数与文件记录一致、能够证明 patch 完整，且其余代码完全相同时，扫描器才会排除该文件。解析器会按声明的扩展名识别 C 风格行注释和块注释、井号注释、SQL 注释、CSS 块注释与 HTML 注释。重命名、不受支持的语言、缺失或不完整的 patch，以及无法确定的注释形式仍需评审。

<a id="security"></a>

## 安全性

具备写权限的 `pull_request_target` job 只检出仓库默认分支。它不会检出或执行 PR 代码，也不使用仓库 secret。PR 文件名仅作为 API 数据处理，并在日志中转义。

所有权变更只有合并到默认分支后才会生效。这可以防止不受信任的 PR 为自身的 workflow 运行修改路由程序或 owner 分配。

<a id="verification"></a>

## 验证

运行 `pnpm run test:request-review` 可检查所有权解析、文件分类、完整 patch 检查、注释解析、分页、日志顺序、草稿取消、评审者过滤和 API 行为。[Workflow 测试](../../scripts/ci-workflow.spec.ts)固定受信任检出、权限、事件和命令。仓库门禁图会在 CI 中运行这两类检查。

<a id="dev-note"></a>

## 开发说明

[评审路由决策](../../.agents/notes/implemented/process/2026-09-08-trusted-changed-file-review-routing.zh.md)记录了安全模型、测试排除规则和备选方案。
