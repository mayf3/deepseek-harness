# Agent Note: 基于受信任的变更文件策略路由评审

Status: implemented

[English](2026-09-08-trusted-changed-file-review-routing.md) | 中文

## 问题

只要匹配路径发生变更，GitHub 原生 CODEOWNERS 就会请求评审者。它无法应用本仓库对需评审的实现或文档文件与纯测试证据的区分。使用原生 CODEOWNERS 文件还会让 GitHub 负责请求决策，而不是由可检查的仓库程序负责。

评审路由需要可观测的变更文件输入、显式 owner 规则、完整的测试排除规则，以及对 fork PR 仍然安全且具备写权限的 workflow。

## 决策

仓库在 GitHub 原生 CODEOWNERS 路径之外的 [`.github/review-ownership/CODEOWNERS`](../../../../.github/review-ownership/CODEOWNERS) 中保存兼容 CODEOWNERS 格式的映射。该映射只接受显式绝对目录模式，每条模式配置一至两名 GitHub 个人用户。通配符、隐藏目录模式、团队、超过两名 owner、重复模式和重复 owner 都会被拒绝。靠后的匹配模式会替换靠前的匹配结果。

策略测试会统计匹配所有权规则的目录中的非测试跟踪文件行数。如果 `@turtle1999` 拥有的有效代码库超过三分之一，测试就会拒绝该映射。

[`request-review` workflow](../../../../.github/workflows/request-review.yml) 在 PR 创建、同步、重新打开、标记为可评审和转为草稿时运行 `pull_request_target` 事件。具备写权限的 job 检出默认分支，只执行默认分支上的扫描器和所有权映射。它不会检出 PR 代码，也不会读取仓库 secret。

扫描器在决策之前获取所有变更文件记录。如果 PR 报告的文件数超过 GitHub API 的 3,000 个文件上限，或者分页只返回了部分列表，扫描器就会失败。它会规范化仓库路径，分别检查重命名前后的路径，并在记录文件名之前进行转义。

扫描器会在匹配 owner 之前排除纯测试路径。排除范围包括名为 `test`、`tests`、`__tests__`、`__snapshots__`、`benches` 或 `stress-tests` 的目录，顶层 `benchmarks` 和 `snapshots` 目录树，`packages/test-support`、`scripts/fixtures` 和 `scripts/snapshots`，以 `.bench.<ext>`、`.corpus.<ext>`、`.e2e.<ext>`、`.perf.<ext>`、`.snapshot.<ext>`、`.spec.<ext>`、`.stress.<ext>` 或 `.test.<ext>` 结尾的文件名，以及 Python 的 `test_*.py`、`*_test.py` 或 `*_tests.py` 文件。`vitest*.config.ts` 和门禁实现等测试基础设施仍需评审，因为它们会改变仓库证据的生成方式。[纯注释路由决策](2026-09-08-comment-only-review-routing.zh.md)记录额外的文档和注释排除规则。

Workflow 会在发出任何评审请求变更之前，依次打印变更代码路径、每类排除项、逐文件 owner 匹配结果和最终评审操作。对于非草稿 PR，它会从按登录名排序并合并的个人 owner 中排除 PR 作者和已经收到评审请求的用户，然后填充最多两个当前个人评审请求名额。现有个人请求即使不匹配所有权映射，也会占用名额。当可用名额无法覆盖剩余候选集合时，登录名顺序会确定性地选择候选人。Workflow 不会从非草稿 PR 移除请求。对于草稿，它会读取完整的评审请求时间线，并取消最近一次请求者为 `github-actions[bot]` 的当前请求；由人员发出的请求保持不变。

## 验证

[扫描器测试](../../../../.github/review-ownership/request-review.test.mjs)覆盖允许的所有权语法、拒绝的语法、每类排除项、生产文件名负向对照、重命名、最后匹配规则、未匹配文件、完整分页、两个 3,000 项上限、先记录后修改的顺序、作者与现有评审者过滤、草稿取消来源和 API 失败。[Workflow 测试](../../../../scripts/ci-workflow.spec.ts)固定事件集合、最小权限、受信任的默认分支检出、不引用 PR head 和 secret，以及执行的命令。门禁图在静态 CI 和 `check-all` 中包含这两组测试。

## 考虑过的替代方案

**使用原生 CODEOWNERS。** 原生路由无法忽略纯测试变更，也无法在请求评审者之前提供由仓库控制的决策日志。

**在 `pull_request` 下运行并检出 PR head。** Fork workflow 无法获得具备写权限的 token，而向不受信任 head 中的代码授予写权限 token 并不安全。

**在 `pull_request_target` 下执行 PR 中的扫描器或 owner 映射。** 这会让不受信任的 PR 选择自己的写权限行为或 owner。

**根据 patch 或语言解析器推断任意语义源码变更。** GitHub 可能省略或截断 patch，而且仓库包含多种语言。扫描器不会尝试证明两个程序行为相同。后续的[纯注释路由决策](2026-09-08-comment-only-review-routing.zh.md)只在变更行计数能够证明 GitHub 提供了完整 patch 时执行有限的词法比较。

## 后果

评审请求修改可以根据受信任的策略、workflow 日志中打印的文件分类，以及 PR 时间线中的请求来源复现。被排除的变更不会请求 owner，草稿 PR 不会保留 workflow 发出的请求。所有权变更只有合并后才会生效，因此修改策略的 PR 无法对自身应用其中不受信任的策略。

Workflow 会请求所有匹配的 owner，不会随机选择一人。因此，共享所有权对每个变更模块最多产生两个请求。GitHub 使用 `GITHUB_TOKEN` 生成的评审请求事件可能不会启动依赖递归触发事件的其他 workflow；这些 workflow 不得把此请求作为唯一触发条件。

已分配目录下不符合任何显式排除规则的变更仍符合请求条件。未匹配的路径会被记录，但不会请求任何人。超过文件或时间线 API 上限的 PR 会失败，并且不会执行不完整的评审者修改。
