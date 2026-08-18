# Agent Note: 产品 subagent 提供方位于共享 profile 宿主

Status: implemented

[English](2026-08-10-product-subagent-providers-in-shared-host.md) | 中文

## 问题

[Codex 与 Claude Code 提供方约定](../feature/2026-08-04-claude-code-and-codex-subagent-backends.md)由两个独立包实现，并在通用 subagent 工具旁加载。Claude Code 包可作为 Profile Bundle 直接安装，而部署环境会显式挂载 Codex 包。Agent Preset 是单个 agent（智能体）的模型可见工具的常规责任方，但 preset 不能安全地拥有任一产品提供方：`ctx.subagents` 是进程级注册表，提供方名称唯一，而宿主消费方会跨会话解析同一个注册表。因此，Host 可用性与 Preset 工具授权分别属于部署决策和 agent 创作决策。

归属决策必须同时保留两个彼此独立的事实：加载提供方不得启动产品，也不得对产品执行身份验证；而工具授权仍须按 preset 决定，这样两个会话才能暴露不同的产品。全局产品开关、按 agent 创建提供方实例或预先枚举的组合 preset，都会为其中一个事实另设第二责任方。

## 决策

Claude Code Bundle 与显式 Codex Host 行都会在共享 Host 平面中恰好加载一次各自固定的提供方。加载任一插件只会注册一个休眠后端；对应的 Codex 或 Claude 进程直到第一次实际委派调用时才启动。Agent Preset 分别通过普通的 `dsh-tool-subagent` 行贡献 `subagent_codex` 与 `subagent_claude_code`，因此一个 preset 可以不授权任何工具、只授权其中一个或同时授权两者，而无需更改提供方注册表。若工具对应的提供方不存在，该工具仍不可用，而不会在 Agent 平面中另行挂载提供方。

[生产依赖闭包决策](../simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.md)只部分取代本说明先前关于默认包含提供方的选择：base 组合包排除两个提供方，Claude Code 包拥有可直接安装的 Bundle patch，而 Codex 仍是显式挂载的 Host 插件。本说明继续负责任一提供方存在时的进程级 Host 放置。提供方约定说明继续负责每个产品的协议、结果映射、取消、进程树生命周期与证据层级。[Agent Preset 架构](2026-08-03-per-session-agent-presets.md)继续负责宿主与 agent 的划分、preset 创作，以及改动只影响新组装会话的规则。

两个提供方的可执行文件归属不同。Codex 会启动从 `PATH` 解析出的宿主 `codex`。Claude Code Bundle 会安装锁定的 Agent SDK 与匹配平台 CLI；提供方让 SDK 选择该私有原生可执行文件，再把命令交给共享子进程责任方，既不查询也不回退宿主 `claude`。加载 Profile 不会创建产品状态、探测版本或测试身份验证；它可以提供每个已挂载 Provider 的部署配置，包括由[非交互权限决策](../feature/2026-08-15-product-subagent-noninteractive-permissions.md)负责的产品专属 `permissionMode` 值，但不会把这些选择移入 Agent Preset 或面向模型的工具。Codex 命令缺失、Claude 平台载荷缺失、身份验证失败和其他产品故障仍局限于发生问题的那次委派。

## 验证

真实组装会覆盖未安装 Claude Code Bundle 与已安装该 Bundle 两种状态，并分别使用保留禁用行或授权该工具的 Agent Preset。测试证明 Host 注册表和模型可见工具会反映这两个决策，组装期间不会启动产品进程，而且 Preset 编辑只影响后续 Session。现有 Codex Loader 与提供方测试会另行证明显式 Host 组装和宿主可执行文件解析。无密钥 ACP（Agent Client Protocol）快照固定模型可见工具 schema，提供方测试则证明 Claude Code 的 SDK 平台载荷选择与无回退行为，以及失败、取消和进程树完全停稳。

## 考虑过的替代方案

**在每个 base Profile 中保留两个休眠提供方。** 这样每条匹配的 Preset 行都能立即使用，但即使用户不需要任一集成，每次生产安装仍会携带两个提供方包、Claude Agent SDK 及其大型平台 CLI 载荷。

**存储全局或按 Profile 配置的产品启用开关。** 进程级开关会与 Preset 争夺模型可见工具的责任归属，也无法表示两个会话使用不同组合。可用性与身份验证属于部署事实，并非另一份需要持久化的产品状态。

**在每个 Agent Preset 内挂载一个提供方。** 提供方名称属于进程级注册表，因此第二个会话会与第一个冲突。宿主消费方也需要独立于任何单个 agent 的生命周期使用该注册表。

**交付四个产品组合 preset。** 四个身份会复制完整组装，只为表示两条独立的工具行。普通行已经能表达完整矩阵，无需新增名单或维护状态。

## 后果

用户只在需要 Claude Code 的 Profile 中安装该 Bundle；使用 Codex 的部署会显式挂载对应 Host 插件。模型可见授权仍通过与其他插件相同的 Agent Preset 创作路径管理。每个新 Session 会获得其 preset 工具行与 Host 可用提供方的交集。存在但未授权的产品保持休眠，会产生包和模块加载开销，但不会启动产品进程、登录、调用模型或创建产品主目录；缺席的产品不会进入提供方闭包。

Host 注册表仍是提供方的唯一权威，Profile Bundle 或显式 Host 组装仍是部署可用性的权威，每个 Preset 仍是模型工具的权威。这个显式的双门生命周期避免全局启用开关，并让包移除与按会话创作保持独立。
