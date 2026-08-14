# @deepseek-ai/dsh-agent-team-web-profile

[English](README.md) | 中文

Agent Teams 的私有 Web profile 层。应当在 `@deepseek-ai/dsh-web-app` 与 [`@deepseek-ai/dsh-agent-team-profile`](../agent-team-profile/README.md) 之后应用。本 patch 先插入实验性 Client Remote assembly，再插入 Team 会话页头 UI；它不修改稳定 Web bundle。

在源码 checkout 中，将两个 Agent Teams 层添加到已初始化的 Web profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/agent-team-profile
pnpm dsh plugin --profile web add ./packages/experimental/agent-team-web-profile
```

Host profile 提供 Team domain 与模型工具。本 Web 层只提供生成式 Client Remote namespace 与浏览器呈现。移除任一实验性 bundle 后，稳定 base 与 Web composition 保持不变。

## 模型体验

间接通过与该 Web 层同时选择的 Host 侧 Agent Teams profile 产生影响。

#### KV Cache 影响

无直接影响；Host 侧 Team 工具负责 prompt 与 schema 变化。

## 已知限制与暂缓事项

- **有序 composition**：`dsh-base`、`dsh-web-app`、`dsh-agent-team-profile` 与本包必须保持该顺序。
- **仅限源码 checkout**：正式 CLI、Web、npm 与 Python 发布产物会排除这个私有包。
