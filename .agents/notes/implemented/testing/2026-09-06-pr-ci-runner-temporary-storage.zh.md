# Agent Note: PR CI 使用 runner 管理的临时存储

Status: implemented

[English](2026-09-06-pr-ci-runner-temporary-storage.md) | 中文

## 问题

Linux 故障切换池在同一台虚拟机上运行多个 runner 实例。PR 覆盖率和快照进程使用操作系统临时目录存放转换后的模块与测试夹具。runner 临时目录之外的文件不受作业清理管理，取消执行阻止进程自行清理时也不例外。该共享目录耗尽会让无关 PR 在测试执行前就失败。

## 决策

[PR CI](../../../../.github/workflows/ci.yml) 的静态检查、覆盖率和消费者作业在任何准备或测试进程启动前，在首个步骤通过 `GITHUB_ENV` 导出 `TMPDIR=runner.temp`。Node、Vite、tsx 和临时测试消费者继承 runner 管理的位置。每个 runner 管理自己的目录，GitHub Actions 在作业开始和完成时清除其中可删除的内容；测试夹具仍分配唯一子目录，并保留自身清理逻辑。

这三个 worker 还将 `npm_config_cache` 设为 `runner.temp/npm-cache`。[发布工作流](../../../../.github/workflows/release.yml) 在既有临时存储准备步骤中采用相同缓存位置，[vendor 演练](../../../../.github/workflows/release-vendor.yml) 也如此。否则，无论 `TMPDIR` 如何设置，npm 都会在共享 home 目录中缓存注册表响应；仅使用临时消费者目录不能隔离这些写入。持久化 pnpm store 保持不变。

[发布演练决策](../process/2026-09-06-release-rehearsal-selfhosted.zh.md) 对发布消费者采用相同的生命周期规则。[故障切换运行手册](../process/2026-07-26-ci-failover-runbook.zh.md) 继续负责 runner 选择和共享主机容量。本变更不调整作业目标、不降低并发、不重试测试、不修改断言，也不修改仅在 master 上执行的 CI。

## ACP 完成顺序的录制

[ACP 诊断场景](../../../../snapshots/session/subagent-acp-diagnostic/cordis.snapshot.yml) 暂停脚本化的后台响应，直到 `job_output` 开始等待完成。没有这种同步，快速子进程可能在录制的父步骤之间发布合法的作业通知。场景本地 wrapper 在 jobs 服务注册完成等待器后释放子进程；mock 在测试私有 workspace 中监听独占创建的标记，并在释放后关闭 watcher。夹具在销毁时恢复被包装的方法。录制的 Session 字节和生产作业通知行为保持不变。

## Workspace 授权夹具的位置

Headless 的 `session-sandbox-root` 夹具声明 `workspace.parent: outside-temp`，而不是依赖 home 所在文件系统。分配器在无需使用系统目录时选择规范化平台临时根目录的同级目录，否则使用 home，并拒绝已被自动临时写授权覆盖的 cwd。在故障切换 runner 上，这让测试留在数据卷中，同时不会让写入借助临时目录豁免而成功。原子 workspace 分配、最终清理、录制的 Session 字节以及独立预期文件保持不变。

## 考虑过的替代方案

**由 PR 作业删除共享临时文件。** 其他 runner 可能仍在使用这些文件。仓库作业不得按路径或文件年龄回收共享目录。

**重试测试或增大超时。** 两者都不能恢复存储空间，也不能为残留文件指定清理责任方。

**将所有作业切换到托管 runner。** 这能避开受影响的虚拟机，但故障切换路径的缺陷仍在，也会改变运维人员独立选择的执行池。

## 影响

遵循临时目录和缓存配置的输出随作业生命周期清理，而不累积于无人管理的主机存储。本方案不回收既有共享临时文件、不保证文件系统容量，也不清理 runner 账号无权删除的文件。历史残留、磁盘配置以及本 PR 工作流以外的作业仍由运维人员负责。

Linux bwrap 和 Landlock 的 workspace-write profile 允许写入字面路径 `/tmp` 和 workspace，而不允许写入其外部继承的 `TMPDIR`；受限测试夹具必须将临时写入放在这些已授权路径中。[快照 spill helper](../../../../packages/test-support/session-snapshot/src/harness.ts) 在 POSIX 上也使用字面路径 `/tmp/dsh-acp-snap-*` 以保持路径长度稳定，因此这些输出仍不受 runner 清理管理。本工作流变更既不扩大沙箱授权，也不重写固定路径夹具。

[ci-workflow.spec.ts](../../../../scripts/ci-workflow.spec.ts) 的 YAML 解析用例要求三个 worker 都包含该赋值，并拒绝步骤级别的覆盖。它们在未修改的工作流上失败。独立进程 smoke 检查和重复 PR 运行验证实际工具链；仅有 YAML 断言不能证明主机容量充足。
