# Agent Note：所有控件共用一个键盘焦点颜色

Status: implemented

[English](2026-09-20-focus-ring-brand-primary.md) | 中文

## 问题

客户端的键盘焦点环至少使用了五种颜色：31 处声明用 `--dsw-alias-state-business-primary`，其余分散在 `--dsw-alias-label-primary`、`--dsw-alias-label-tertiary`、`--dsw-alias-state-warn-label`、`--dsw-alias-border-l4` 和两种按钮填充色上。完全没有声明焦点环的控件则回退到浏览器默认环，其颜色跟随操作系统强调色——同一个构建在一台机器上显示橙色、另一台显示蓝色，控件本身没变颜色却变了。

## 决策

所有键盘焦点环统一使用 `--dsw-alias-brand-primary`。

实现分两部分，缺一不可。`ui-theme/src/styles/focus.css` 声明全局 `:focus-visible { outline-color: var(--dsw-alias-brand-primary) }`，覆盖那些画浏览器默认环的控件；49 处原本指定了其它颜色的组件声明改为同一个 token。只改颜色：每条声明保留自己的宽度、样式和 offset。

全局规则只设置 `outline-color`。自带焦点环的组件不受影响，因为它的 `.class:focus-visible` 选择器权重高于裸 `:focus-visible` 规则；没有焦点环的控件则继承品牌色，而不是系统强调色。

## 考虑过的其他做法

**只重写组件声明。** 49 个显式焦点环会一致，但所有依赖浏览器默认环的控件——包括侧栏轨道的切换按钮——仍会画出操作系统强调色，而这正是本次改动要消除的可见症状。

**给剩下每个控件单独加焦点环声明。** 结果相同，但每新增一个控件都会重新引入缺陷，直到有人记得补环；壳层样式还得预判它渲染的每个可交互元素。

**连宽度和 offset 一起统一。** 反馈中的不一致确实包含这两项，但已确认的设计决策只覆盖颜色。在设计定下之前，宽度和 offset 保持逐组件。

**把所有 `outline: none` 改为共享焦点环。** 这些声明分别对应刻意的替代方案（内嵌 `box-shadow` 环、容器级焦点处理），或用于抑制本就不应显示焦点的容器。删除它们会改变颜色之外的行为。

## 影响

焦点颜色不再跟随操作系统强调色，因此录屏和截图在不同机器上可复现。组件保留自身几何形状，从未声明焦点环的控件现在与已声明的控件一致。全局规则是决定兜底颜色的唯一位置，未来的设计变更只需改一处 token 引用，而非每个模块。

`ui-theme/tests/client-styles.client.spec.ts` 固定了该样式表在注入顺序中的位置。`pnpm run test:gui` 覆盖客户端套件；录制式 Web 回放覆盖组装后的浏览器。
