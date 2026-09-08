# Agent Note: CI 断言等待所属操作完成

Status: implemented

[English](2026-09-08-ci-readiness-and-completion.md) | 中文

## 问题

[master 空 PR 的运行](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34206953049)在等待 Webhook Session 创建一秒、等待 PowerShell 输出五秒时失败。两个测试都不衡量启动延迟保证。[另一次运行](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34207864157)在 Desktop worker 就绪测试中暴露了相同的局部短时限问题，并在输入框仍保留已提交命令时截取了反馈确认。

## 决策

[Webhook 浏览器测试](../../../../apps/web/tests/github-ready-review.e2e.ts)在投递前注册 scaffold 的轮次完成观察，等待完成后再检查 Session 注册和模型请求。[反馈测试](../../../../apps/web/tests/feedback-command.e2e.ts)在比较 ARIA 输出前等待输入框清空且附件按钮启用。连续两次快照相同不能证明命令 RPC 已完成：事件流可能先发布确认消息。

[Desktop 事务测试](../../../../apps/desktop/tests/project-manager.spec.ts)为 worker 就绪标记使用当前测试的执行预算。即使所有权断言失败，清理也释放并等待阻塞的 worker。[PowerShell 后台输入测试](../../../../packages/shell/pwsh-local/tests/executor.spec.ts)等待进程完成后检查完整输出、完成状态与退出码，并在清理中处置其 Context。消费式读取仍由独立的流式测试覆盖。

[子 Agent 拆卸决策](2026-09-07-subagent-teardown-test-budgets.zh.md)负责生命周期清理预算。[持久 PowerShell 决策](2026-09-07-pwsh-ci-observable-completion.zh.md)负责精确与推断的终端就绪状态；一次性进程的完成 Promise 具有不同语义。

## 考虑过的替代方案

**增大独立等待时限。** 已有完成 Promise 时不采用。独立轮询期限仍会与执行通道的预算竞争。

**刷新反馈 golden。** 不采用：保留内容的输入框与禁用的附件按钮描述了尚未完成的提交。已稳定的预期 UI 仍是目标行为。

**串行化 CI 或重试这些测试。** 不采用：两者都不能建立缺失的完成条件，也不能在断言失败后释放阻塞的子进程。

## 后果

就绪与输出断言保留原有的内容和所有权检查。受控的 worker 启动延迟与命令响应延迟可复现原始失败，并在采用完成等待后通过。执行通道仍为挂起设置上限；PowerShell 和进程清理仍需在原生 Windows 上验证。
