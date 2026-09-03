# Agent Note: 通用 preset 只提供一套编辑工具

Status: implemented

[English](2026-08-10-default-presets-single-editor.md) | 中文

## 问题

`standard`、`code` 和 `cordis` preset 同时提供 `read`/`write`/`edit` 文件系统工具与 `str_replace_editor`。两套接口在常规文件查看和编辑上重叠，导致每次请求都携带额外的工具 schema，却没有增加独立的默认能力。`minimal` preset 最初把持久 `bash` 之外的 `str_replace_editor` 保留为单独的组合例外。

## 决策

`standard`、`code` 和 `cordis` preset 配置挂载 `dsh-tool-fs` 与 `dsh-tool-fs-search`，但不挂载 `dsh-tool-str-replace-editor`。因此 PTC mode 的注册表和生成的 SDK 均不包含 `str_replace_editor`。后续的[仅持久 shell 决策](2026-09-03-minimal-profiles-persistent-shell-only.zh.md)会从随附的 `minimal` 与 `sdk-minimal` 组合中移除 editor。部署配置与用户自定义 preset 仍可显式挂载该插件。

此决策收窄 preset 工具清单，不移除工具包及其 Python 运行时支持。较早的[共享清单决策](../feature/2026-07-31-even-out-shipped-tool-rosters.zh.md)继续说明与 surface 无关的工具为何归 preset 组合所有；本记录说明编辑器例外。

## 曾考虑的替代方案

**在通用 preset 中保留两套编辑接口。** 不予采用，因为重叠的模型可见 schema 增加了工具选择，却没有提供不同的默认操作。

**从发行物中删除 `str_replace_editor` 包。** 不予采用，因为显式部署仍是该独立插件的有效消费方。

## 后果

通用 agent 使用 `read`、`write` 与 `edit` 完成文件系统修改，minimal agent 则使用持久 shell。Preset 组合测试会固定每份随附 preset 及 PTC mode SDK 都不包含 `str_replace_editor`。
