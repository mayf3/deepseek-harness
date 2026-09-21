---
description: "在普通 Cordis YAML 中定义 Agent 的子插件列表。可同时声明多个 preset，由会话选择。声明会提前加载，修改只影响之后创建的 Agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-preset

[English](README.md) | 中文

## 概述

在普通 Cordis YAML 中定义 Agent 的子插件列表。可同时声明多个 preset，由会话选择。声明会提前加载，修改只影响之后创建的 Agent。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins: []
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `id` | 必填 | 稳定的 preset 标识符 |
| `plugins` | 必填 | 子插件行列表 |
| `name` | 未设置 | 展示名称 |
| `description` | 未设置 | 展示说明 |
| `order` | 未设置 | 列表排序 |

声明行的 `id` 是 Loader 编辑地址；`config.id` 是会话保存的 preset 标识符。子插件可省略行 ID，由 Loader 分配。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[index.ts](src/index.ts) 注册定义并把清理函数交给 Cordis。插件的 group 标记保留子配置中的 `!!js`，直到对应子插件加载时才求值。代际持有与释放由 [注册表](../agent-preset-registry/README.zh.md) 管理。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Scope](../../core/scope/README.zh.md) — 注册隔离。
- [Agent](../../core/agent/README.zh.md) — 会话运行时。
- [Cordis](../../../docs/cordis-primer.zh.md) — 插件配置与生命周期。

<a id="model-experience"></a>
## 模型体验

通过声明的插件间接影响模型，这些插件拥有模型可见工具和提示词。

#### KV Cache effect

同一 Agent 的组合保持稳定；新 Agent 可使用更新后的定义。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 需要 `agentPresets` 服务。重复的 preset ID 会导致声明加载失败。声明不提供目录、文件复制或文件删除操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion；本插件仅提交由注册表管理的定义，没有可独立偏离的运行时状态。
