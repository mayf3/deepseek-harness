# Agent Note：pi-ai 适配器保留原始工具参数并以 toolcall_end 约束分发

Status: implemented

[English](2026-10-07-pi-ai-raw-tool-arguments.md) | 中文

## 问题

pi-ai 在流式过程中解析工具参数，并用宽松解析器修复未闭合 JSON。适配器把修复后的对象重新序列化进 harness 的 raw-string 词汇，导致在 `tool_calls`/`stop` 后被截断的流会执行一个修复了一半的参数对象。Responses 协议还有第二个来源缺口：初始参数前缀（`response.output_item.added`）与非前缀最终替换（`response.function_call_arguments.done`）从不出现在 delta 序列中，因此拼接 delta 不是 provider 的最终 raw 字符串；缺少 `output_item.done` 的 `response.completed` 更会留下从未完成的调用。

## 决策

pi-ai 的 `toolcall_end` 事件新增可选 `rawArguments` 字符串，由各 provider 在删除 scratch 缓冲前从权威最终缓冲捕获（空串也包含；无 raw 的原生对象协议省略该字段）。适配器只认这一权威 final：严格 `JSON.parse`（绝不用宽松修复）、仅接受对象、空串立即失败，并用 `deepEqualJson` 对解析后的事件对象做一致性守卫——畸形 raw 原样保留交给既有工具参数校验器。观察到的 delta 仍按原文保留，无 raw 字符串的 provider 继续使用对象序列化回退。

`tool-calls` finish 还要求所有已开始的调用都已被 `toolcall_end` 完成。共享的 `BlockAssembler` 会从未闭合 delta 组装出可执行块，因此未完成调用不得到达可分发 finish——无论其 delta JSON 恰好能否解析；`max-tokens` 保持丢弃语义，error/aborted finish 本就不分发。

## 已否决的替代方案

- **沿用重新序列化解析对象**——丢失 provider 精确字节并执行修复后的截断对象；即本缺陷本身，否决。
- **把拼接 delta 当作权威**——对 Responses 前缀/替换流误拒，且完全看不到替换；否决。
- **只依赖工具参数校验器**——未完成调用在组装 JSON 恰好合法时绕过它，这正是历史上的执行形态。

## 后果

- 截断或被替换 final 的参数流一律失败关闭；合法的 Responses 前缀、added-only final、done-only final 与非前缀替换以 provider 精确字节执行。
- 无可信 raw 字符串的 provider（Google/Vertex 原生对象、grammar 自定义工具输入、旧 pi-messages 对象-only final）保持回退语义，其解析对象含义不变。
- 合法 JSON 中遗漏业务字段（缺图边、弱化 schema）在该边界仍不可检测；schema 收紧是独立工作。
- 需要成对的 `@earendil-works/pi-ai` 0.82.1 线 `rawArguments` 事件字段；pi-ai 补丁产物缺失时 Responses 覆盖不生效，上游协调（earendil-works/pi，#9461 触及同一区域）适用。
