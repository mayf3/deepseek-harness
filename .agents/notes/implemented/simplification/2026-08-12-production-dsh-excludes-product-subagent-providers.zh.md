# Agent Note: 生产 dsh 排除产品 subagent 提供方

Status: implemented

[English](2026-08-12-production-dsh-excludes-product-subagent-providers.md) | 中文

## 问题

`@deepseek-ai/dsh` 会获得 `@deepseek-ai/dsh-base` 的依赖闭包。如果 base 包含 Codex 与 Claude Code subagent 提供方，每次生产安装都会下载可选的产品集成代码，包括 Claude Agent SDK 及其解包后约 250 MB 的平台 CLI 载荷，即使用户并未使用任一集成。

## 决策

本决策只部分取代[共享 host 放置决策](../architecture/2026-08-10-product-subagent-providers-in-shared-host.md)中关于默认包含提供方的部分：`@deepseek-ai/dsh-base` 不依赖也不挂载 Codex 与 Claude Code subagent 提供方。现有的每个提供方包改为可直接安装的 Profile Bundle，其 `dsh.bundle.patch` 指向包自身拥有的 `cordis.patch.yml`。该 patch 恰好贡献一条挂载自身提供方的 Host 行，不包含 Agent 工具行。

两个 Bundle 彼此独立。Codex Bundle 自己负责运行时依赖 `@deepseek-ai/dsh-sdk-protocol`，并继续使用 `PATH` 中的宿主 `codex`。Claude Code Bundle 自己负责锁定的 Agent SDK，以及从 SDK optional dependencies 中选出的匹配平台 CLI；生产运行只使用该私有 CLI，绝不会回退到宿主 `claude`。安装其中一个 Bundle 不会带入另一个，默认的 `@deepseek-ai/dsh` 生产依赖闭包既不包含任一提供方，也不包含 Claude Agent SDK 或其平台载荷。已安装的 Bundle 会在下次 Profile 启动时注册一个休眠提供方，而 Agent Preset 独立决定新 Session 是否获得对应工具。安装只会把所选包闭包放到磁盘上；它不会启动产品、验证账户、改写原生设置或向模型授予访问权。

## 验证

包测试会固定每个 Bundle 的 manifest、发布 patch、准确的自身提供方行以及产品专属运行时闭包。Claude 覆盖会固定 Agent SDK 0.3.220、Claude Code 2.1.220、八个平台包的身份与版本、SDK 所选可执行文件进入共享子进程责任方的路径，以及载荷缺失时第一次委派失败且不回退宿主 CLI。工作区验证会从 Bundle 声明派生每个发布 patch，而非维护包目录。生产闭包测试证明默认、仅 Codex 与仅 Claude 三种依赖边界；真实 Bundle patch 与 Agent Preset 的组装会覆盖四种安装集合、同时安装两个提供方时的完整工具授权矩阵、缺失提供方的代表场景以及零产品进程。base 组合包测试仍会拒绝这两个提供方依赖与配置行。

## 考虑过的替代方案

**在 base 组合包中保留休眠提供方。** 休眠提供方不会启动产品进程，但其包仍会进入每次生产 NPM 安装。

**新增 wrapper 或 meta Bundle。** 第三个包会重复安装责任，使独立移除变得更间接，却不会贡献新的运行时能力。

## 后果

安装 `@deepseek-ai/dsh` 时，不会通过 base 组合包下载任一产品提供方。Profile 可以直接添加或移除任一提供方包，也可以同时操作两者；Host 可用性的变化会在下次 Profile 启动时生效。选择 Claude Code 代表明确接受其 SDK 与一个大型平台 CLI 载荷，而选择 Codex 不会安装产品 CLI。单独创作的 Agent Preset 仍只会向新组装的 Session 授予模型可见工具。本决策不引入 wrapper 包、meta Bundle、动态安装程序或持久化的产品启用状态。
