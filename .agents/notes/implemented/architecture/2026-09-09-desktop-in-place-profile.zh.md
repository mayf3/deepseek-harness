# Agent Note: 直接修改 Desktop profile

Status: implemented

[English](2026-09-09-desktop-in-place-profile.md) | 中文

## 问题

staging 能保留旧插件安装，但增加 profile 复制、目录移动、恢复日志和回滚状态。本地插件变更接受失败后显式修复，以避免这些复杂度。

## 决策

Desktop 停止 Host 后直接修改当前 profile。修改包前解除宿主共享链接，操作结束后恢复链接。保留包锁和已批准的原生构建。兼容升级只刷新链接，不复制插件文件。

包操作或 Host 失败会保留部分修改，供修复和重试。不使用 staging profile、激活日志、目录切换恢复或自动回滚。已有临时目录不会被解释或删除。

本记录取代[打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)、[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)及[立即显示窗口决策](2026-09-09-desktop-immediate-window-and-direct-start.zh.md)中的暂存与回滚。Host 启动遵循[薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)；发布、模块归属与窗口生命周期仍由各自决策负责。

Desktop 将安装和生命周期脚本交给 pnpm，不设置待完成操作启动门禁、不强制按锁文件重装，也不自动重建。包操作失败会保留部分变更，仍可禁用、删除、重置和重试启动。Host 继承用户环境，profile 可以使用目录链接。未经修改的旧版 Desktop 生成 pnpm 配置替换为 Web 默认值；自定义配置仍由用户管理。

## 考虑过的替代方案

staging 以复制和崩溃恢复为代价保护旧安装。版本化目录仍需要准备、选择和清理。直接写入放弃自动恢复；只有无人值守恢复的产品要求能证明这些成本合理时，才重新引入。

## 后果

测试覆盖离线初始化、原地升级、写入前失败、Host 失败后保留修改、pnpm 部分失败、宿主链接恢复及独占包操作。签名应用和 GUI 验收仍由发布环境负责。
