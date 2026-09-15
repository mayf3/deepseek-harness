# Agent Note: Profile 命令简写

Status: implemented

[English](2026-09-15-profile-command-shorthand.md) | 中文

## Problem

Profile 启动需要一种适用于自定义名称的简洁写法，同时不能让插件管理依赖 Harness home 中的内容。

## Decision

CLI 在解析前，将开头非选项且非 `plugin` 的参数展开为 `--profile <name>`。两种写法使用相同的启动器 flag、应用参数透传和 profile 校验。`plugin` 保持命令优先级；`dsh --profile plugin` 显式选择同名 profile。

## Alternatives considered

- 将 profile 注册为命令需要扫描文件系统，并使解析依赖已安装的 profile。
- 让 profile 优先于内置命令，会使安装 profile 改变插件管理调用的含义。

## Consequences

自定义和内置 profile 共用一种简写，无需新增公开类型。名称必须紧跟 `dsh`；未知名称会触发现有的 profile 缺失诊断。移除专用的 `web` 命令后，已选定的 profile 也能将 `web` 作为应用参数接收。解析等价性测试、构建产物验收和无密钥 headless 工具往返场景覆盖共用的启动路径。
