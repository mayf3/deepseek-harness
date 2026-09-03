# Agent Note：移除字符串替换编辑器

状态：已实现

[English](2026-09-03-remove-str-replace-editor.md) | 中文

## 问题

现有随附 profile 都不再需要独立的 `str_replace_editor` 接口。通用 profile 已提供 `read`、`write` 与 `edit`，下一代模型的 minimal contract 则只提供持久 shell。继续保留这个闲置包，仍会发布其实现、依赖闭包、配置面、生成目录条目、客户端展示分支和模型 schema 快照。

隐藏或不挂载工具不等于完整移除。用户自定义配置仍可挂载它，未来的组合改动也可能意外恢复该 schema。

## 决策

从 workspace 与发行物中删除 `@deepseek-ai/dsh-tool-str-replace-editor`。移除共享 base 行、已禁用的 Web override、CLI 与 Python runtime 依赖、TypeScript project alias、工具目录注册、客户端专用 diff 与 produced-file 处理、包文档、测试和录制场景。重新生成的配置目录、模块图、组合图和请求快照不得包含该包或面向模型的工具条目。

不保留兼容 alias、隐藏注册或替代包。通用 profile 保留 `read`、`write`、`edit`、`glob` 与 `grep`；minimal profile 保留按平台选择的持久 shell。历史中的未知工具事件可以使用现有客户端 generic fallback，但项目不再宣传或测试已移除的 contract。

本决策取代[原始持久工具决策](../feature/2026-07-29-persistent-bash-str-replace-editor.zh.md)中 editor 的部分、[独立包例外](2026-08-10-default-presets-single-editor.zh.md)以及[极简 profile 范围边界](2026-09-03-minimal-profiles-persistent-shell-only.zh.md)。原始 note 继续负责持久 Bash 行为；极简 profile note 继续负责单 shell contract。

## 考虑过的替代方案

**为显式自定义组合保留该包。** 不予采用，因为目前没有随附消费方，而 opt-in 包仍会扩大受支持与发布的表面。

**保留注册并从模型请求中过滤。** 不予采用，因为展示设置可能恢复该能力，而且每个 runtime 都会继续携带闲置代码。

**在 `read`／`write`／`edit` 上提供 alias 或兼容 shim。** 不予采用，因为项目仍处于发布前阶段，shim 会保留本次改动要删除的 schema 与维护成本。

## 后果

点名已删除包的用户自定义配置会明确失败，必须迁移到 `read`、`write`、`edit` 或 shell。这是 v41 发布前适配中接受的兼容性破坏。

只有新决策给出不同且当前存在的消费方、明确的组合 owner、包与 runtime 闭包、面向模型的文档和测试后，已移除接口才能重新引入。在此之前，源码、发布 manifest、生成目录与当前快照均不包含 `str_replace_editor` 工具。
