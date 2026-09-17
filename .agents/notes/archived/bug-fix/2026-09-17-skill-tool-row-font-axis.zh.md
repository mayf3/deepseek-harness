# Agent Note: Skill 工具行跟随共享字号轴

Status: implemented
Archived: 2026-09-17

[English](2026-09-17-skill-tool-row-font-axis.md) | 中文

## 问题

收起的 Skill 工具行使用固定的 14px 文字、24px 行和 16px 前置槽，而普通工具行使用全局 secondary 字号层级与内容字号增量。因此 Skill 在默认设置下更大，并且用户修改内容字号时不会与对话中的其他工具行一起缩放。

## 决策

收起的 Skill 行为标题与摘要使用 `--dsh-content-font-size-secondary`，并把 `--dsh-content-font-delta` 应用于行高、行高度、前置槽和业务图标。这些声明与普通工具行及共享 `DisclosureRow` 摘要行一致。展开的 Instructions 卡片保留独立的标题、代码字体、间距和控件。

## 考虑过的替代方案

**保留固定的 Skill 排版。** 否决，因为 Skill 行是工具调用摘要的同级元素，不应与相邻工具行各自缩放。

**把完整 Skill 行迁移到 `DisclosureRow`。** 本次修正不采用，因为现有的展开 Instructions 布局与交互已经由本组件拥有；对齐共享字号声明即可消除可见差异，无需重构组件。

## 测试

Skill 行样式测试固定 secondary 字号变量、内容字号增量、收起行高度、前置槽尺寸和图标尺寸。手工编写的 `skill-tool-row` Web 回放会在已发布组合中修改全局字号变量，并检查标题、摘要、行和图标的计算尺寸。现有 Skill 组件测试继续覆盖生命周期、展开和持久化回放行为。

## 后果

收起的 Skill 行会与普通工具行同步改变字号，并继续与其对齐。展开的 Instructions 卡片不继承本次变化。
