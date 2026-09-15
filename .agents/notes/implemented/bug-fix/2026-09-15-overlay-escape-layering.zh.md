# Agent Note: 打开的菜单从所在对话框手中接管第一次 Escape

Status: implemented

[English](2026-09-15-overlay-escape-layering.md) | 中文

## 问题

`Modal` 与 `Menu` 各自在 document 上挂 keydown 监听来响应 Escape。因此对话框内打开的菜单会被关闭对话框的同一次按键一并关掉：一次 Escape 丢掉用户上下文中的两层，并把键盘留在对话框打开前的位置。设置页的每一行、工作区浏览器与终端正文都会在对话框内渲染菜单。

## 决策

对话框把第一次 Escape 让给已打开的菜单。当 `document.querySelector('[role="menu"]')` 命中时，`Modal` 的 keydown 监听直接返回，于是菜单自己的处理关闭菜单并把焦点还给锚点；第二次 Escape 才到达对话框。不渲染 `[role="menu"]` 的菜单——composer 的触发菜单与 popupSelect 面板都是 listbox——保留各自的分层，不受影响。

## 备选方案

**给两个监听排顺序。** 两者都挂在 `document` 上，谁先执行取决于注册顺序：对话框先于它所打开的菜单挂载，因此永远是对话框先跑。把规则寄托在这个顺序上并不可靠。

**用服务维护一个浮层栈。** 只有一处两层嵌套，不值得为此引入机制，也没有其他调用方需要这个顺序。

**让一次 Escape 关掉两层。** 这正是本决策要消除的行为：一次按键不该丢掉用户打开的菜单与对话框两者。

## 验证

[对话框测试](../../../../packages/client/ui-primitives/tests/atoms.client.spec.tsx) 在打开的 `Modal` 内渲染一个 `Menu`：第一次 Escape 关闭菜单、对话框保持打开且键盘落在菜单锚点上，第二次 Escape 才到达对话框。

## 影响

Escape 现在逐层退出：先菜单，后对话框。对话框内没有菜单时，它自身的 Escape 仍直接关闭；不渲染 `[role="menu"]` 的菜单也永远不会拦下对话框的 Escape。
