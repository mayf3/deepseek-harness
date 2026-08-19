# Agent Note: 隔离 Agent Teams 浏览器 Remote adapter

Status: implemented

[English](2026-08-19-isolate-agent-team-browser-remote.md) | 中文

## 问题

Agent Teams domain service 除 roster、mailbox、task 与 lifecycle 行为外，还负责浏览器专用 Remote method、view composition 与 transport error mapping。挂载其生成式 contribution 还需要一个具有 inert Host entry 及 Host、Client 两个 compiler face 的独立 package。这些职责为单一 consumer 扩大了 `ctx.teams`，并在没有独立 runtime owner 的情况下引入 compiler layout 例外。

## 决策

`@deepseek-ai/dsh-team` 是仅负责 domain 的 `ctx.teams` service。`@deepseek-ai/dsh-agent-team-remotes` 提供无状态 Host adapter，注册为 `ctx.teamRemote`，并使用独立 Typert wire namespace `teams`。其 `view`、`createTask` 与 `updateTask` method 委托给 Cordis injection 选择的同一个 `ctx.teams` instance。浏览器 view type 与封闭 task-mutation result 归 adapter package 所有；Team error 在此映射，意外 failure 仍保持 rejection。

Adapter package 只注册到 Host aggregate。它生成 `ctx.remote.teams` Client contribution，但没有 Client plugin entry 或 inert Host half。`@deepseek-ai/dsh-client-ui-agent-team` 通过稳定 `ctx.remote` service 挂载该 contribution，并从自身 plugin lifecycle 返回生成式 disposer。

## 考虑过的替代方案

**在 `TeamService` 上保留 Remote method。** 拒绝，因为 view composition 与 carrier-facing error mapping 只服务浏览器 consumer，会使 domain service 的公共 API 依赖单一 presentation。

**保留独立 Client assembly package。** 拒绝，因为该 assembly 没有 Host 行为，却仅为 inert root export 与一次 `$mount()` call 要求 Host 和 Client 两个 compiler face。

**将 Team contribution 加入稳定 API Remotes。** 拒绝，因为稳定 release package 不能依赖私有 experimental package，且这样会使 Team namespace 成为随附 Client assembly 的一部分。

## 测试

Adapter 单元测试校验 service-key 分离、delegation、business-error mapping 与意外 rejection propagation。生成式 artifact 与 plain-Node build check 校验导出的 `teams` descriptor。浏览器测试校验 contribution mount 与 disposal，Web composition test 通过真实 gateway 执行 Host adapter。

## 后果

`ctx.teams` 是 Team state 的唯一 owner，不公开浏览器专用 operation 或 value。Web profile 增加一个无状态 Host service，UI package 负责 contribution mount。增加浏览器 operation 时，只需修改 adapter 及其生成式 artifact，无需改变 Team domain interface。
