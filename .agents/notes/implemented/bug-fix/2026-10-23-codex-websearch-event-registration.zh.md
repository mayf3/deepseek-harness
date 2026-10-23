# Agent Note：在持久化词汇表中注册 Codex web 搜索事件

Status: implemented

[English](2026-10-23-codex-websearch-event-registration.md) | 中文

## 问题

仓库外的 `dsh-openai-codex` provider 插件在每次搜索 dispatch 前，会向发起会话的持久化日志追加一条不带标记的 `web/openai-codex-search-llm-request` 事件。持久化读取路径会拒绝任何包含 `KNOWN_SESSION_EVENT_TYPES` 之外事件类型的日志，除非该事件携带 envelope 的 `ignorable: true`（`assertEventsSupported`），因此当从未挂载该插件的 worker 第一次 resume 这类会话时，会拒绝整份日志，使会话的全部历史不可用。该故障在 worker 重启、空闲回收和 fence 清理时全舰队性爆发，并且在临时的部署树修补与数据修补之后复发：部署树直改会被发布覆盖，运行时注册只覆盖加载了写入插件的进程。

## 决策

该事件现在是本构建持久化词汇表的永久成员。core session 声明了精确的事件类型与精确的、不含密钥的 payload record（`OpenAICodexSearchLlmRequest`，镜像自插件的写入方），生成的 catalog 通过正常的 `gen-persistence-catalog` 运行把该类型加入 `KNOWN_SESSION_EVENT_TYPES`。因此本仓库的每一个构建都能读取携带该事件的日志，与挂载了哪些插件无关，且已写入的无标记日志无需任何数据改写即变为可读。

注册是精确匹配，不是命名空间规则：`web/openai-codex-search-llm-request` 是唯一新增成员，其它所有未知类型——包括未知的 `web/*` 名字——仍然拒绝日志；required-on-read 默认值与 `ignorable` envelope 契约均不变。读取行为在其他方面不受影响：事件保持原有顺序与序列号，业务消息既不重放也不去重。

## 已考虑的替代方案

**插件侧运行时注册** —— 插件的 `installOpenAICodexSearchEvent` 已经把该类型加入运行进程的集合。作为修复被否决：注册只存活于进程生命周期内，且只存在于挂载了插件的进程中，而这正是生产中失败的组合；已部署的插件版本已经在运行时注册，投毒仍然复发。

**由写入方把事件标记为 ignorable** —— 在此被否决：写入方在另一个仓库；加标记无法让已写入的无标记日志变为可读，并且会把加载安全性承诺从词汇表转移到每一个未来遥测写入方的自律上。

**忽略整个 `web/*` 命名空间** —— 被否决：这会静默放行未来未知的 web 语义事件，破坏保护日志解释的 fail-closed 默认值。

**core 内通用的运行时注册面** —— 作为本修复被否决：它共享进程生命周期的局限，而构建期词汇表条目是唯一能覆盖无插件读取者（新 worker、工具链、UI 进程）的注册面。

## 后果

使用 Codex web 搜索的会话在本仓库源的每一个构建中都能跨 worker 重启 resume。catalog 将该 payload 记录为权威契约。有一个跨仓库后续需要协调，但不阻塞：插件通过自己的 `declare module` merge 用本地命名的 payload 类型声明了同一个 key，因此当它针对携带本注册的 harness 构建做类型检查时，该重复 merge 必须改为引用 harness 类型或直接删除。操作员侧的过渡缓解（数据扫描、部署树补丁、launchd 守卫）在本注册发布后由部署线决定退役。
