# Agent Note: Desktop standard macOS window menus

Status: implemented

[English](2026-09-16-desktop-window-menus.md) | 中文

## 问题

Desktop shell 用自定义模板替换了 Electron 的默认应用菜单，该模板此前只列出应用菜单和“编辑”菜单。Electron 只构建模板中声明的 role，因此 macOS 失去了默认模板提供的“文件”和“窗口”菜单，包括“关闭窗口”（⌘W）和“最小化”（⌘M）。这两个快捷键在 Desktop 应用中都没有任何效果，而其他 macOS 应用会响应它们，用户无法用自己熟悉的快捷键让主窗口离开屏幕。

## 决策

macOS 上的模板在“编辑”菜单之前声明 `{ role: 'fileMenu' }`，在其之后声明 `{ role: 'windowMenu' }`。“关闭窗口”（⌘W）、“最小化”（⌘M）、“缩放”、“全部置于顶层”和打开窗口列表都由这两个 role 提供；Electron 按应用语言本地化它们的标签，因此 Desktop 词典无需改动。Windows 和 Linux 仍然只有应用菜单和“编辑”菜单。

关闭主窗口与点击窗口红绿灯按钮走同一条路径：dsh Host 继续运行，点击 Dock 图标或触发 `activate` 会重新创建窗口。`window-all-closed` 仍只在非 macOS 平台退出应用。

## 考虑过的替代方案

**把 ⌘W 绑定为最小化窗口。** 反馈提到的是 ⌘W，但 macOS 把最小化留给 ⌘M，所有同类应用都用 ⌘W 关闭最前窗口。把最小化绑到 ⌘W 会违背这份反馈所依据的平台惯例。

**只声明“窗口”菜单。** 该菜单提供最小化和缩放，但不提供关闭，反馈中的 ⌘W 仍然无效。

**在应用子菜单里直接加一个 `{ role: 'close' }` 项。** 这样可以避免只有一个命令的“文件”菜单，但会把窗口命令放到 Plugins、Updates、Quit 这些应用级命令中间，没有 macOS 应用这样排布。

**在所有平台都声明“文件”和“窗口”菜单。** 同一份模板在那些平台会把 Ctrl+W 声明为关闭；应用只有一个窗口，关闭它会触发 `window-all-closed` 并退出应用，把窗口快捷键变成用户没有要求的退出路径。

## 影响

macOS 恢复了自定义菜单压掉的窗口命令，代价是 [Desktop README](../../../../apps/desktop/README.zh.md) 需要持续解释这两个菜单 role。role 标签跟随 Electron 的语言环境而不是 Desktop 词典，现有的“编辑”菜单也是如此。

## 测试

`apps/desktop/tests/main-startup.spec.ts` 中的一个用例固定了 macOS 与 Windows、Linux 上声明的菜单 role。基于 role 的菜单项由本机执行，因此程序化的 `click()` 和 vitest 的 Electron mock 都无法触达这些快捷键；用真实 Electron 44 运行同一模板显示，只有在本改动之后才出现“关闭窗口”（⌘W）和“最小化”（⌘M）。
