# Agent Note: 通过共享 Web 应用运行 Desktop

Status: implemented

[English](2026-09-10-desktop-web-wrapper.md) | 中文

## Problem

独立的 Desktop 组合与请求传输需要分别维护配置、模块加载、流式响应与资源服务行为。即使共享渲染界面，这些实现也可能遗漏 Web 功能。Desktop 需要独立安装与原生控件，但不需要第二套应用后端。

## Decision

私有 Desktop Host 针对独立归属的 Desktop profile 调用 CLI 的共享 profile runner。完整 Web 组合负责认证、HTTP 路由、客户端资源、RPC 与响应流。Electron 加载子进程报告的认证 URL。子进程 IPC 承载就绪与关闭；应用请求直接通过 HTTP 传输。

共享 runner 负责 profile 与 Harness-home patch、代理设置、遥测默认值、模块补全、配置重载及应用生命周期。Desktop 保留 Web 默认值与用户配置。原生目录选择是具有可见 UI 用途的 Desktop overlay；壳窗口、菜单、插件管理、恢复及更新仍由 Electron 负责。

[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)保留独立运行时与插件存储、内置 Node.js 和 pnpm，以及明确的包归属。[原位修改决策](2026-09-09-desktop-in-place-profile.zh.md)保留包事务与部分失败恢复。公开 CLI 继续拒绝保留的 Desktop profile。

本记录部分取代[打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)中的私有组合与无端口传输。该设计避免监听端口，并使用分帧字节管道避免 Base64 膨胀与跨版本 V8 序列化。共享 HTTP 放弃无端口保证，将服务与认证交给已有 Web 实现。发布身份、签名、进程归属及原生壳功能仍是有效决策。

## Alternatives considered

**维护第二套后端组合与传输。** 这允许应用不监听端口，但每项 Web 路由、重载行为、认证变化和流式能力都需要 Desktop 实现或明确省略。只有无法使用 Web 实现、且足以承担持续维护成本的桌面产品需求，才支持重新引入这种方案。

**合并 CLI 与 Desktop 插件安装。** 共享启动代码不要求共享可执行依赖。独立安装允许分别验收发布与插件版本，共享会话和设置则仍由已有数据归属方负责。

## Consequences

Desktop 通过相同启动与服务路径继承 Web 功能。HTTP 监听归属与认证仍属于应用启动，Electron 必须加载就绪 URL，而不是假设端口或转换请求。独立加载与恢复窗口在 Web 应用启动前仍可用。

验证需要覆盖共享 runner、认证 HTTP 资源与 API 传输、配置重载、原生目录选择、子进程关闭及插件失败恢复。安装后平台验收与真实模型 GUI 验收独立于单元测试；本记录不声称已测得启动或传输提升。
