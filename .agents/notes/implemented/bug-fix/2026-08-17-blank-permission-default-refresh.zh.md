# Agent Note: Refresh blank session permission defaults

Status: implemented

[English](2026-08-17-blank-permission-default-refresh.md) | 中文

## Problem

Web 新会话流程会复用工作区中的空白会话，而不是不断创建隐藏占位会话。权限默认值在会话创建时被固定到该会话中，因此当某个空白占位会话已经存在后，用户再修改「通用设置」里的权限默认值，这个占位会话仍会保留旧预设。下一次“新”对话复用它时，权限 chip 就会和刚保存的默认设置不一致。

## Decision

`dsh-permission-presets` 将设置变更视为推进可复用空白占位会话的时机。当 `defaultPreset` 变化时，服务会扫描 live sessions，找到尚未开始过轮次的会话，并且只切换那些有效权限仍等于旧默认值的会话。已经开始过轮次的会话绝不会被改变。用户已经在空白会话中手动切离旧默认值的会话也会保持原样。

这样既保留了既有的 Web 空白会话复用策略，也让被复用的占位会话观察到与真正新建会话相同的默认值。更新仍走常规 preset setter，因此持久的 `permission/preset`、`sandbox/mode` 与 `approval/policy` 事实继续作为投影和执行的单一来源。

这项修复部分细化了较早的[新会话权限默认值](../feature/2026-07-31-permission-default-for-new-sessions.md)决策：已经开始的会话和带 seed 的恢复仍保持固定，而未带 seed 的空白占位会话可以推进，因为 Web 会将它们作为新会话复用目标。

## Alternatives considered

**权限设置变化后禁用空白会话复用。** 拒绝，因为这会留下额外的隐藏占位会话，并让新会话行为更不确定。既有复用策略有价值；错误只在于权限默认值过期。

**让客户端比较空白会话的权限投影和 Settings 行。** 拒绝，因为 workspace runtime 需要理解 permission settings namespace，或为这个场景新增跨插件 hook。权限服务已经拥有默认值，也能修复自己的空白占位会话。

**无条件更新所有空白会话。** 拒绝，因为用户可能在发送第一条 prompt 前，刻意切换当前空白会话的权限。只匹配旧默认值可以更新过期占位会话，同时避免覆盖明确的空白会话选择。

## Consequences

设置变更可能向未带 seed 的空白会话追加权限事实，但这些会话仍保持 blank，因为 blankness 由是否缺少 `turn/start` 定义。已经开始的对话、带 seed 的恢复，以及已有用户显式选择预设的空白会话都会保留原权限。
