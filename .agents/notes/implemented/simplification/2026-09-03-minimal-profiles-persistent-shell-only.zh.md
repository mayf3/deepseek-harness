# Agent Note: 极简 profile 只提供持久 shell

Status: implemented

[English](2026-09-03-minimal-profiles-persistent-shell-only.md) | 中文

## 问题

随附 Web `minimal` preset 与独立 `sdk-minimal` profile 在持久 shell 之外还提供 `str_replace_editor`。Shell 已经可以检查和修改文件，editor 仍会为每个极简模型请求增加第二种文件修改接口及其完整 schema。它还要求挂载一个专用 `fs-local` 服务，而两份极简组合中的其他配置项都不使用该服务。

下一代模型的极简运行时要求只提供一个面向模型的工具。如果保留 editor 的挂载，只通过呈现层过滤隐藏它，那么呈现配置变化时，该能力仍可能重新出现。

## 决策

随附的极简组合只提供一个按平台选择的持久 shell：Linux 与 macOS 使用 `bash`，Windows 使用 `pwsh`。两份组合都不挂载 `@deepseek-ai/dsh-tool-str-replace-editor`、文件系统工具或支撑 editor 的 `fs-local` 服务。固定的 complete persona、运行时上下文与 compaction 的缺失、shell 超时和各启动路径的宿主服务保持不变。

后续的[完整移除决策](2026-09-03-remove-str-replace-editor.zh.md)删除独立 editor 包及其全部消费方。本 note 继续负责随附 `minimal` 与 `sdk-minimal` 默认组合的精确单 shell 组成。

精确组合测试会断言单工具清单以及 preset 内不存在文件系统服务。`sdk-minimal` bundle 测试与构建后配置转储会断言配置项和依赖 allowlist 都不含未使用的文件系统 provider。Web 与打包 Python 的模型可见快照会固定单工具 schema 清单。

该决策部分取代[通用 preset 使用一种 editor](2026-08-10-default-presets-single-editor.zh.md)、[minimal preset 组合](../bug-fix/2026-08-10-minimal-preset-owns-rl-composition.zh.md)、[极简裸运行时](../feature/2026-08-11-minimal-profiles-bare-two-tool-runtime.zh.md)与[独立 sdk-minimal profile](../architecture/2026-08-24-standalone-sdk-minimal-profile.zh.md)中的极简例外。这些 Agent Note 继续负责提示词所有权、无 compaction 行为、profile 启动与 bundle 分层；完整移除决策负责删除包。

## 考虑过的替代方案

**保留 editor 配置项并隐藏其 schema。** 不予采用，因为呈现层或限制层会让该能力继续留在极简组合中，并使其缺失依赖另一项设置。

**从发行物中删除 editor 包。** 当时不予采用，因为显式自定义组合被视为有效消费方。后续完整移除决策接受了 v41 兼容性破坏。

**只在 `sdk-minimal` 中保留 editor。** 不予采用，因为两条极简路径会向同类模型提供不同的工具约定，而且打包 SDK 路径仍会承担 schema 成本和未被其他配置项使用的文件系统服务。

## 后果

极简 agent 通过持久 shell 检查和修改文件。模型请求只携带一个工具 schema，组合不拥有文件系统服务。通用 profile 保留原生文件系统工具；过时 editor 包不再发布。
