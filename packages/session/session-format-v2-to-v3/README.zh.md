---
description: "将已发布的 v2 系统提示恢复为受保护的 v3 消息并规范化信封，保留历史请求含义。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v2-to-v3

[English](README.md) | 中文

## 概述

本库将已发布的 v2 系统提示恢复为受保护的 v3 消息，规范化事件信封，并转换持久化 PTC 词汇。它保留历史请求含义、源事件时序、时间戳、消息身份与继承归属，同时重映射经过审计的序列引用。持久化通过静态 Session 格式目录使用本库。本库不发布或修改持久化文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 使用场景

恢复时请使用[目录](../session-format-catalog/README.zh.md)。直接导入用于目录组装和测试；本库不挂载到 Cordis 组合中。

### 入口

```text
const targetHeader = sessionFormatV2ToV3.migrateHeader(sourceHeader)
```

头部版本变为 3。`header.agentPreset` 和每条 `agent-preset/selected.data.agentPreset` 中精确匹配的旧预设标识 `code` 变为 `ptc`，包括继承的选择事件。其他预设标识以及缺失的头部预设保持不变；选择事件缺少字符串预设标识时会被拒绝。结构阶段在首个 `step/start` 后立即插入空 `system/message`，随后在每次提示发生变化的 `request/header` 前替换受保护的头节点，包括清空提示。每个请求头的 `header.system` 均被移除，不移动任何源事件。仅含元数据的日志不添加头节点。

结构插入和引用重映射完成后，规范化将原始与合成信封上的精确替换对象从 `{ op: 'replace', start, end }` 重命名为 `{ op: 'replace', startSeq, endSeq }`，并省略请求头中的 `tools: []` 与 `adapterDefaults: {}`。最终规范化保留其输入事件数、坐标、时间戳、顺序与继承切点；此前的结构阶段会改变事件数、序列、经过审计的引用与切点。仅含空白的系统内容、`config.stop: []` 与嵌套 header/source/data 扩展保持原样。

四种 surface 类型（`system/message`、`user/message`、`assistant/message`、`tool/result`）都要求 `surfaceOp`；只有 assistant 消息禁止 `sourceEventSeqs`。替换端点按当前 surface 顺序而非数值序号顺序标识闭区间。已知仅日志事件禁止两个 surface 元数据字段。原生未知或已退役的可忽略信封保持不透明。携带 `data.error` 的 `tool/result` 要求其工具结果块带有 `isError: true`；失败结果可以省略错误身份。缺失位置、额外替换键、别名与矛盾结果会被拒绝，绝不修复。原生 V3 拒绝任何 `header.system` 及非规范的空请求头可选字段。

通过目录组装使用[公共导出](src/index.ts)：迁移、源与目标编解码器、目标头校验器及目标恢复器。事件本地检查不为插件自有载荷定义完整 schema。

阶段将 `tool/code-dispatch-start` 和 `tool/code-dispatch` 映射为 `tool/ptc-dispatch-start` 和 `tool/ptc-dispatch`。它在用户消息、收件箱插入消息与标题请求消息中，将精确匹配的 `tools-code-mode` 插件归属替换为 `tools-ptc`，不改写 ID、工具参数或内容。原生 V3 拒绝必需的前代 PTC 标签，包括出现在可恢复行损坏之后的标签；可忽略的前代标签保持不透明，不能满足当前 PTC 关系。V2 源输入中的 V3 保留 PTC 标签即使可忽略也会被拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[阶段](src/migration.ts)同步输出，保留坐标映射、消息身份集合与当前提示、生命周期状态，并增量展开紧凑事件段。它从最后一个继承 end-seed 标记推导目标继承切点，包括上游阶段在 EOF 前无法提供切点的情况。[引用映射器](src/references.ts)重映射本地信封溯源与替换范围、命令源引用、压缩范围与列表，以及标题消息列表。投递水位、会话引用捕获坐标、工作流计数器、嵌入的模型输入与消息 ID 保留原有含义。声称已获 V3 接收的 V2 投递标记会被拒绝。

[校验器](src/validation.ts)独立检查规范信封、系统载荷、开放步骤归属与受保护的头节点操作。原生 V3 也接受历史内系统消息追加、非头节点替换，以及非头系统节点的压缩。冻结的普通关系校验接收由私有 system/PTC/repair 视图与规范端点视图组合而成的输入；结果保留原始 V3 事件、ID 与实际目标代次。生成的修复 ID 后缀仍是历史身份，而非当前序列坐标。冻结的 v0-to-v1 与 v1-to-v2 语义保持不变。

[编解码器](src/codec.ts)共享冻结的 V2 物理分帧与溯源编码，并在编码前及解码后验证 V3 事件本地规则。已退役系统头字段、畸形系统载荷与必需前代 PTC 的拒绝先于可恢复解码。未分类事件的元数据在识别事件词汇的恢复阶段之前保持不解释；该阶段拒绝未知必需类型并校验已安装的仅日志信封，编解码器不能把这些必需记录当作畸形规范尾部丢弃。严格读取立即拒绝规范格式错误；已提交前缀恢复不产出无效后缀，若后续 `turn/end` 证明该后缀已提交，则会拒绝它。[准入测试](tests/admission.spec.ts)覆盖畸形持久化载荷、修复身份、受保护头节点违规与压缩引用重映射。本库不拥有可独立观察的运行时注册或状态副本，因此不发布运行时不变量伴随入口。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [已发布 v1 到 v2](../session-format-v1-to-v2/README.zh.md) — 冻结的源编解码器和事件校验。
- [Session 格式协议](../session-format/README.zh.md) — 相邻流式阶段。
- [规范 V3 信封决策](../../../.agents/notes/implemented/architecture/2026-09-06-v3-canonical-session-envelopes.zh.md) — 精确转换与拒绝依据。

-----

<a id="model-experience"></a>
## 模型体验

### 历史日志恢复

#### 模型看到什么

`sessionFormatV2ToV3` 在每个历史请求处保留提示文本与普通消息。空头节点不产生模型消息。PTC 插件来源使用 `tools-ptc`；仅日志的分发事件不会添加模型消息。

#### Token 影响

不添加或删除消息内容。

#### KV Cache 影响

阶段不改变消息内容或模型配置。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **历史预设归属** — 已发布 V0/V1/V2 的预设引用中，`code` 表示旧内置预设。这些日志无法区分同名的自定义预设；原生 V3 引用不会被重新解释。本库不迁移 `settings.yaml`。
- **不发布文件** — 持久化负责不可变后继代的发布；本包绝不覆盖已发布代。
- **保持时序的输入** — 首个步骤前出现表面事件，或在开放步骤之外更改提示时，以 `SessionFormatUnsupportedMigrationError` 拒绝；移动事件或虚构步骤外的系统消息会破坏重建。
- **经过审计的迁移词汇** — 显式分类 V2 事件（包括仅日志 Assistant 尝试）与已安装的消息反馈扩展。Agent 中继归属与文件附件元数据保持不变，其标识符与字节计数不被解释为序列引用。迁移拒绝未知事件（即使标为可忽略）及未知消息来源或内容种类，因为无法推断其序列依赖。原生同版本读取保留普通可忽略事件的准入规则及嵌套扩展，禁止已退役的 `header.system` 与必需的前代 PTC 标签。
- **不修复语义** — 无效已发布记录与矛盾工具结果会使恢复被拒绝；转换器绝不补充源事件缺失的位置，也不改写无关载荷。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
