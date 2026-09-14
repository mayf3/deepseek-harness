---
description: "热重载插件代码和 profile 配置，并与包操作互斥执行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hmr

[English](README.md) | 中文

## 概述

在应用运行期间重载插件源码和配置。模块替换、Include 刷新与已注册的 profile 文件处理器和包修改共用一个队列。`ctx.hmr` 保留现有 Cordis HMR 的配置和事件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

live profile 自动启用配置监听。如需监听源码模块，在启动前通过 profile patch 配置 base 组合包提供的 `hmr` 条目：

```yaml
- id: hmr
  disabled: false
  config:
    root: ["."]
```

已有配置将模块名 `@deepseek-ai/cordis-plugin-hmr` 替换为 `@deepseek-ai/dsh-hmr`。继续提供 `hmr` 服务键、`baseDir`、`config`、`getLinked()`、`getOuterStack()`、`hmr/change` 和 `hmr/reload`。工作区保留 vendored 包；DSH profile 使用本包。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `base` | Context 的 base URL | 模块监听的基准目录。 |
| `root` | `["."]` | 模块监听目录；`[]` 仅保留显式注册的配置监听。 |
| `ignored` | `["**/node_modules", "**/.*", "cache", "data"]` | 排除的模块路径。 |
| `debounce` | `100` | 合并模块变化的毫秒数。 |

Chokidar 选项（包括轮询）保持原有含义。精确配置监听同时观察新增、删除及初始不存在的父目录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`watchConfig()` 注册会被等待的配置处理器。`runExclusive()` 将调用方的修改与自动重载串行化，并拒绝嵌套事务。`hmr/before-reload` 瀑布事件让启动器在每次自动重载期间持有 profile 文件锁；主动修改的调用方在 `runExclusive()` 内以相同顺序取得文件锁。事务期间收到的文件事件在事务结束后处理。

启动器保留 profile 解析和 patch 优先级规则。HMR 负责监听器、模块缓存替换和重载调度。未知文件通知不获取重载锁，因此锁文件事件不会触发下一次取锁。不发布 invariant 伴生入口，因为队列和监听注册没有独立的持久投影。

模块替换实现源自 `@cordisjs/plugin-hmr` 1.0.15，包含 Harness 的 Node loader 和惰性配置修改。保留其 [MIT 许可证](LICENSE)。

</details>

<a id="model-experience"></a>
## 模型体验

### 被重载的插件

#### 模型看到什么

`ctx.hmr` 不添加模型工具或消息。加载后的插件决定后续工具和提示词贡献。

#### Token 影响

没有直接的 token 贡献。

#### KV Cache 影响

重载提供上下文的插件可能改变后续请求前缀；HMR 不改写对话历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 模块替换需要 Node loader 内部接口。框架依赖变化调用宿主提供的 `loader.exit()` 钩子；HMR 本身不重启进程。
- 通过插件管理器替换已安装包版本仍需要重启。浏览器 Client 模块图保留独立的浏览器侧加载机制。

### 开发备注

<a id="dev-note"></a>

无。
