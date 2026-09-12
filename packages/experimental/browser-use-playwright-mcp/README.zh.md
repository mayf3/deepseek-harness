---
description: "通过 Playwright MCP 操作 Chromium，为每个活动 Session 保持独立浏览器状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-playwright-mcp

[English](README.md) | 中文

## 概述

通过 Playwright MCP 的上游工具检查网页并操作 Chromium。每个活动 Session 使用独立服务器进程。可以启动独立浏览器，也可以让一个 Session 接入已有浏览器，使用其现有标签页和登录状态。本包以实验状态发布，仅在显式挂载后启用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在已提供 Agent、工具和系统提示词的 profile 组合中挂载以下条目。浏览器安装遵循上游运行时；使用 `executablePath` 选择已有 Chromium 安装。

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
  config:
    mode: launch
    headless: true
```

使用 `mode: attach`，并在 `endpoint` 中设置 HTTP(S) 调试 URL 或 WS(S) 浏览器端点，即可操作已有浏览器。Session 在加载浏览器工具时占用附加连接，并持续保留直到卸载。其他 Session 和子 Agent 可继续各自的轮次，但不获得这些工具；清理完成后，后续轮次可以获取附加连接。其他 Session 的直接调用会失败。清理只断开连接，保留外部浏览器及其页面。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | 必填 | `launch` 或 `attach`，在本次提供方激活期间固定 |
| `headless` | `true` | 启动时不显示窗口 |
| `executablePath` | 上游发现 | 启动使用的 Chromium 可执行文件 |
| `endpoint` | attach 时必填 | 已有浏览器调试端点 |
| `toolCallTimeoutMs` | MCP 客户端默认值 | 单次调用超时，单位为毫秒 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-browser-use-playwright-mcp)列出接受的字段。浏览器模式由 profile 或 preset 选择。子进程会清空继承的 `PLAYWRIGHT_MCP_*` 选项，避免其替换该配置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

提供方解析固定版本 npm 包的可执行入口，并使用当前 Node 启动。[共享运行时](../browser-use-runtime/README.zh.md)在模型 schema 收集前发现工具，并串行执行同一 Session 的调用。[MCP 客户端](../../mcp/mcp-client/README.zh.md)负责标准输入输出、注册、取消和结果投影。提供方不另行维护共享运行时或 MCP 连接的状态观测，因此不发布运行时不变量配套入口。

只要活动 Session 保持连接，浏览器状态就会跨轮次保留。销毁会等待服务器关闭，再释放资源。重新加载后恢复 Session 会创建新的浏览器运行状态；已保存的对话历史不会还原 Cookie 或页面。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [浏览器使用](../../../docs/subsystems/browser-use.zh.md) — 提供方选择与 Session 所有权。
- [浏览器使用服务](../../browser-use/browser-use/README.zh.md) — 提供方独占注册。
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) — 上游安装与浏览器行为。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器工具与截图

#### 模型可见内容

工具以 `mcp__playwright-mcp__<tool>` 命名，保留上游描述和 JSON schema。文本与截图通过常规工具结果流程进入 Session 日志。截图需要附件存储及支持图片输入的模型路由；其他路由会收到 MCP 图片诊断。提供方不添加系统提示词指导。

#### Token 影响

工具目录会增加工具定义。调用会向 Session 历史加入参数、文本和获准输入的图片。内联图片字节不进入模型可见历史。

#### KV Cache 影响

不变的工具目录会保留工具定义前缀。结果追加到历史；更换提供方或目录可能降低前缀复用率。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

本集成保留固定版本服务器的浏览器与工具限制。

- 仅支持 Chromium；不可选择 Firefox 或 WebKit。
- 服务器连接丢失后，调用持续失败，直到重新加载提供方或重启主机。重连已禁用，避免静默替换浏览器状态。
- 连接独占仅在此提供方实例内有效。其他进程与浏览器用户仍可修改相同页面。
- 取消不会撤销已发送给浏览器的导航、点击或其他操作。
- 工具 schema 跟随固定的实验依赖版本，不承诺 DSH 稳定性。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
