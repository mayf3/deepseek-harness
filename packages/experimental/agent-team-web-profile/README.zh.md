# @deepseek-ai/dsh-experimental-agent-team-web-profile

[English](README.md) | 中文

Agent Teams 的私有 Web profile 层。应当在 `@deepseek-ai/dsh-web-app` 与 [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.md) 之后应用。本 patch 插入 Team 会话页头 UI；它不修改稳定 Web bundle。

在源码 checkout 中，将两个 Agent Teams 层添加到已初始化的 Web profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/agent-team-profile
pnpm dsh plugin --profile web add ./packages/experimental/agent-team-web-profile
```

Host profile 提供 Team domain、生成式 Remote method 与模型工具。本 Web 层挂载生成式 Client Remote namespace 并提供呈现。移除任一实验性 bundle 后，稳定 base 与 Web composition 保持不变。

## 模型体验

间接通过与该 Web 层同时选择的 Host 侧 Agent Teams profile 产生影响。

#### KV Cache 影响

无直接影响；Host 侧 Team 工具负责 prompt 与 schema 变化。

## 已知限制与暂缓事项

- **有序 composition**：`dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile` 与本包必须保持该顺序。
- **Preset scope 内的 legacy control**：稳定 Web preset 仍会在 preset scope 中挂载 continuable Subagent control。顶层 Host profile override 不会替换这些 scoped registration，因此在 Web 提供 Team-aware preset 之前，Team roster 与 legacy child control 可能同时出现。[Web Agent Teams 决策记录](../../../.agents/notes/implemented/feature/2026-08-06-agent-teams-web.md)记载了这项暂缓的 composition 工作。
- **仅限源码 checkout**：正式 CLI、Web、npm 与 Python 发布产物会排除这个私有包。
