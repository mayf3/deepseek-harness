# Agent Note：实验性 Agent Teams Web 控件

状态：已实现

[English](2026-08-06-agent-teams-web.md) | 中文

## 问题

持久 Agent Teams runtime 负责 roster、mailbox 与 task 状态，但只提供模型工具和 Host service method。Web 用户需要查看 teammate 活动、按同样的 compare-and-set 规则管理共享任务，并打开 teammate 会话。Agent Teams 仍处于实验阶段，因此这些能力不能向稳定 API Proxy、Client runtime、Subagent UI 或 Web bundle 增加 Team 专用 contract 或依赖。

## 决策

私有 `ctx.teams` service 除 domain operation 外，还直接负责生成式 `teams/view`、`teams/createTask` 与 `teams/updateTask` Remote method。Team package 负责浏览器安全的 view 与 mutation-result type。View 包含 roster 与当前 task 状态，但不包含 pending mailbox 内容或已删除 task tombstone。Task conflict 通过封闭 business result 跨越 Remote，使浏览器保留 `team-task-conflict`；transport 与 lookup failure 仍是普通 `RemoteResult` failure。

`@deepseek-ai/dsh-client-ui-agent-team` 通过稳定 `ctx.remote` service 挂载 `@deepseek-ai/dsh-team/remote` contribution，随后直接消费生成式 `ctx.remote.teams` method，不增加 Client result 包装层。它展示 roster status、model 与 diagnostics，并支持 task create、edit、dependency update、assignment、completion、reopen 与 deletion。每次 mutation 都发送当前显示的 revision。Conflict 仅在重新读取完整 Team view 成功后要求用户检查；如果重新读取失败，则保留该错误。重叠 refresh 只发布所选 Session 的最新请求，成功 mutation 会让更早的 refresh snapshot 失效。

Teammate navigation 使用既有 `{ parentSessionId, childSessionId, mode: 'continuable' }` Subagent address，不带 Team tag。UI 刷新直接 child catalog、再次检查所选 Session，然后打开 addressed conversation。History 与后续人类 prompt 使用稳定 Subagent 路径；Team mailbox 只用于 Team 工具发起的 Team peer delivery。

`@deepseek-ai/dsh-agent-team-web-profile` 在稳定 Web bundle 之后只插入 UI。它与 Host 侧 `@deepseek-ai/dsh-agent-team-profile` 一起应用，后者已经插入 `ctx.teams` 与模型工具。两个稳定 bundle 都不包含禁用的 Team row 或依赖。

## 边界

Web UI 不提供 mailbox timeline、worktree 或 Git control、teammate creation、rename、deletion、interrupt 或自动 merge。它不会从 task ownership 或 write scope 推断文件系统权限。导航到 teammate 后的人类 continuation 是普通 addressed-child prompt，不是 Team mailbox message。

## 考虑过的替代方案

**扩展 legacy API Proxy Team RPC map。** 拒绝，因为这会把实验性 domain 放入稳定 wire package，并重复生成式 Remote vocabulary 与 validation。

**引入独立的浏览器 Remote service。** 拒绝，因为这些 method 没有区别于 `ctx.teams` 的状态、lifecycle 或 policy owner；第二个 Cordis service 会重复 Team injection，并要求另一个 package 提供同一个 Typert namespace。

**向稳定 Subagent address 与 prompt routing 添加 Team metadata。** 拒绝，因为普通 child navigation 已经标识会话；Team tag 会让稳定 Client 与 Subagent contract 耦合实验性 mailbox policy。

**在稳定 Web bundle 中加入禁用 Team row。** 拒绝，因为禁用 row 仍会产生 release 依赖，并让实验性 package 成为随附 composition 的一部分。

## 测试

Team service 单元测试、生成流程与 plain-Node built-artifact smoke 校验直接 Remote method、error mapping 与导出 descriptor。Client typecheck 与浏览器 component test 覆盖挂载 namespace、Lead routing、原始生成式 result、所有 task action、成功及失败的 conflict reload、陈旧 async result、navigation、dispose 与状态或错误呈现。Web 端到端测试在真实 Host Remote flow 上组合两个实验性 profile 层。

## 后果

Team service 是 domain state 与公开选定 Team value 的 Remote operation 的唯一 Cordis owner。稳定 API Proxy、Client runtime、Subagent UI 和 Web bundle 保持 Team 无关。源码 checkout 用户必须向 Web profile 添加两个有序 experimental profile 层；promotion 可以移动这些 package，而无需修改 npm name 或生成式 namespace。
