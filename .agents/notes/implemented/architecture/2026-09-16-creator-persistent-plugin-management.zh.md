# Agent Note: 创造模式安装持久化插件组合包

Status: implemented

[English](2026-09-16-creator-persistent-plugin-management.md) | 中文

## Problem

agent 需要安装能力并在同一段对话中使用。生成代码工具在普通已安装组合包之外引入了第二套插件生命周期。

## Decision

创造模式启用现有的 `plugin_manager` 工具。agent 将包和 Loader YAML patch 写入工作区文件，再通过 `install_bundle` 安装。MCP 连接是插入已安装 `dsh-mcp-client` 的纯配置组合包；UI 组合包包含 Host 入口和 Client 产物。profile 锁、包安装、启停和 HMR 继续由现有管理器负责。

模型可见两个只读 Cordis 检查工具，不再提供生成代码的 define/run/stop/undefine 和动态自省工具 API。现有运行时和 Client 消费者保留其服务；历史会话卡片仍然可读。这仅取代[自引用工具集决策](../feature/2026-07-08-self-referential-cordis-toolset.zh.md)中的模型侧变更流程；其运行时所有权和沙箱依据仍有独立价值。[profile 事务决策](2026-09-14-current-profile-plugin-management.zh.md)继续规定锁、包安装和部分失败行为。

除非用户指定其他目标，视觉创建请求默认通过已安装的 Client 插件显示在当前 Web 页面。开发 skill 提供最小包和由 effect 管理的 Client 注册示例。已知所需 API 后结束探查，在可选视觉优化之前先安装能工作的初版。有条件时使用已连接页面验证。浏览器认证或操作系统设置不是安装插件的前提，mock 预览不能证明应用内结果。

## Alternatives considered

通用条目增删改查和 MCP 专用管理 API 重复了组合包文件及现有安装、启停操作能够表达的能力，提示驱动的安装不需要这些接口。将生成代码的版本管理搬入 Plugin Manager 会保留两套生命周期，且无法提供普通包的持久化方式。

## Consequences

已选择的组合包影响 profile 中的所有会话，并在重启后保留。HMR 在实时 profile 中激活新组合包；替换已安装的包需要重启。agent 分别报告保存状态和激活结果，并验证所需能力。副作用归属于插件生命周期，包括样式表清理。

构建后的 Web profile 测试安装 MCP 组合包，检查现有和新建创造模式会话，重启进程，并验证移除组合包后的工具释放。录制会话无需模型凭据即可回放管理器启用已配置 MCP 条目及后续真实本地 MCP 请求。历史卡片测试保留已移除工具的已保存展示。
