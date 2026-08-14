# Agent Note：实验性 Agent Teams Web 控件

状态：已实现

[English](2026-08-06-agent-teams-web.md) | 中文

## 问题

持久 Agent Teams runtime 负责 roster、mailbox 与 task 状态，但只提供模型工具和 Host service method。Web 用户需要查看 teammate 活动、按同样的 compare-and-set 规则管理共享任务，并打开 teammate 会话。Agent Teams 仍处于实验阶段，因此这些能力不能向稳定 API Proxy、Client runtime、Subagent UI 或 Web bundle 增加 Team 专用 contract 或依赖。

## 决策

`TeamService` 直接提供三个 Typert Remote method：`teams/view`、`teams/createTask` 与 `teams/updateTask`。生成式 codec 使用浏览器安全的 `@deepseek-ai/dsh-team/client` vocabulary。View 包含 roster 与当前 task 状态，但不包含 pending mailbox 内容或已删除 task tombstone。Task conflict 通过封闭 business result 跨越 Remote，使浏览器保留 `team-task-conflict`；transport 与 lookup failure 仍是普通 `RemoteResult` failure。

`@deepseek-ai/dsh-agent-team-remotes` 是私有 Client assembly，通过稳定 `ctx.remote` service 挂载生成式 Team contribution。`@deepseek-ai/dsh-client-ui-agent-team` 只消费 `ctx.remote.teams`、Client Session navigation、locale 与 slot。它展示 roster status、model 与 diagnostics，并支持 task create、edit、dependency update、assignment、completion、reopen 与 deletion。每次 mutation 都发送当前显示的 revision。Conflict 会重新读取完整 Team view 并要求用户检查，不会自动重试或覆盖。重叠 refresh 只发布所选 Session 的最新请求，成功 mutation 会让更早的 refresh snapshot 失效。

Teammate navigation 使用既有 `{ parentSessionId, childSessionId, mode: 'continuable' }` Subagent address，不带 Team tag。UI 刷新直接 child catalog、再次检查所选 Session，然后打开 addressed conversation。History 与后续人类 prompt 使用稳定 Subagent 路径；Team mailbox 只用于 Team 工具发起的 Team peer delivery。

`@deepseek-ai/dsh-agent-team-web-profile` 在稳定 Web bundle 之后插入私有 Remote assembly 与 UI。它与 Host 侧 `@deepseek-ai/dsh-agent-team-profile` 一起应用。两个稳定 bundle 都不包含禁用的 Team row 或依赖。

## 边界

Web UI 不提供 mailbox timeline、worktree 或 Git control、teammate creation、rename、deletion、interrupt 或自动 merge。它不会从 task ownership 或 write scope 推断文件系统权限。导航到 teammate 后的人类 continuation 是普通 addressed-child prompt，不是 Team mailbox message。

## 考虑过的替代方案

**扩展 legacy API Proxy Team RPC map。** 拒绝，因为这会把实验性 domain 放入稳定 wire package，并重复生成式 Remote vocabulary 与 validation。

**向稳定 Subagent address 与 prompt routing 添加 Team metadata。** 拒绝，因为普通 child navigation 已经标识会话；Team tag 会让稳定 Client 与 Subagent contract 耦合实验性 mailbox policy。

**在稳定 Web bundle 中加入禁用 Team row。** 拒绝，因为禁用 row 仍会产生 release 依赖，并让实验性 package 成为随附 composition 的一部分。

## 测试

Team Remote 生成与 Host build 校验 typed method。Client typecheck 与浏览器 component test 覆盖挂载 namespace、Lead routing、所有 task action、conflict reload、陈旧 async result、navigation、dispose 与状态或错误呈现。Web 端到端测试在真实 Host Remote flow 上组合两个实验性 profile 层。

## 后果

Team service 仍是唯一状态机，Web 是 typed projection 与 command adapter。稳定 API Proxy、Client runtime、Subagent UI 和 Web bundle 保持 Team 无关。源码 checkout 用户必须向 Web profile 添加两个有序 experimental profile 层；promotion 可以移动这些 package，而无需修改 npm name 或生成式 namespace。
