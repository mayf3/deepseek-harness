# Agent Note: 保持 Chat 展示与 Trajectory 查看独立

Status: implemented

[English](2026-09-14-chat-presentation-defaults.md) | 中文

## 问题

Trajectory 查看适合直接展示完整的已记录思考。将该默认行为应用到 Chat 会在思考期间展开实时对话，并在回答或工具调用到来时改变其高度。Trajectory 查看改动还为 Chat 增加了历史首 token 计时恢复，却没有独立的 Chat 行为决策。

## 决策

[Chat](../../../../packages/client/ui-chat/README.zh.md#turn-process-folding) 的每个思考行初始都折叠，后续输出和结算保留用户手动选择的展开状态。回复计时使用观测到的实时 chunk；冷加载历史不从内嵌流中恢复首 token 时间。轮次级过程折叠仍独立维护。

[Trajectory 查看](../feature/2026-09-09-ptc-trajectory-code-inspection.zh.md) 保留思考默认展开、已记录计时、JSON 控件和 PTC 代码查看器。[紧凑流读取器](../architecture/2026-09-06-embedded-stream-record-readers.zh.md) 仍供 Trajectory 和其他消费方使用。这些决策部分取代了 Chat 展示增量，同时保留两份记录各自独立的理由。

## 考虑过的替代方案

**保留 Chat 自动展开和历史计时恢复。** 这些改变了所请求的 Trajectory 查看工作之外的 Chat 行为。重新引入任一行为都需要独立的 Chat 产品决策及相应验证。

**撤回整个查看改动。** 这会在撤回意外 Chat 改动的同时移除所请求的 Trajectory 行为。

## 影响

Chat 思考需要点击才能查看全文，重新打开的回复可能缺少首 token 和解码指标。组件测试覆盖流式与仅思考回复的默认折叠、回答和工具调用到来时的手动展开状态，以及冷加载历史计时。已记录的生命周期与轮尾浏览器场景验证组装后的 Chat 行为；Trajectory 测试保留其独立默认值和计时。
