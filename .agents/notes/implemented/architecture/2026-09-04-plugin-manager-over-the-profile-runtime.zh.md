# Agent Note: 插件管理器驱动 profile runtime

Status: implemented

[English](2026-09-04-plugin-manager-over-the-profile-runtime.md) | 中文

## Problem

CLI 与 Web 需要相同的安装检查，而只有运行中的应用才能应用组合包变更或检查活跃行。把两类职责都放在 Web 宿主会迫使 CLI 依赖该宿主或重复实现安装器。Profile 清单、用户 patch 和 pnpm 操作也需要协调修改，避免并发请求覆盖彼此的意图。

## Decision

**一个业务管理器，一个 Remote 适配器。** `dsh-plugin-manager` 位于 app-boot 旁。`PluginInstaller` 操作 profile 文件和 pnpm，不需要运行中的 Loader；`PluginManager` 在其上增加面向运行中 profile 的组合包与行操作。CLI 共用安装器。`dsh-host-plugin-manager` 提供逐次调用的 profile runtime 与运行中 agent 数读取器，转接方法并将 `PluginOperationError` 错误码映射为 Remote 错误。缺少 profile runtime 时在调用处报告 `plugins/unavailable`。管理器读取运行中 agent 的数量，不依赖 agent 实现。

**同时只允许一个变更。** 重叠变更收到 `plugins/busy`，不进入可能携带过期假设的队列。有 agent 运行时，安装与移除以 `plugins/agents-running` 拒绝，因为 pnpm 会重写这些 agent 导入的模块。组合包与行编辑不改 `node_modules`，不使用这一限制。每次操作重新读取 profile 清单：依赖记录安装，`dsh.profile.bundles` 记录启用。

**pnpm 保留正常的启动环境。** 安装器使用独立的 `subprocess-local/spawn` 进程管理，并在 Windows 上通过 shell 处理 `.cmd` 垫片。Registry 凭据与代理配置保持可用。输出以 job id 下的 `plugins/install-log` 流式发送，按请求保留终端颜色；启动失败、超时与非零退出以 `plugins/install-failed` 和有界日志尾部报告。add 失败时会在进程退出后恢复保存的清单与锁文件；不恢复包文件或共享下载缓存。安装后进行静态声明和组合包冲突检查；未知包保留安装，新组合包保持禁用，除非调用方请求启用。没有需要维护的发现缓存目录。

**启用选择层，诊断描述实际行。** 组合包启用和非事务重组遵循[原生条目诊断](2026-09-11-native-entry-diagnostics.zh.md)。管理器区分逐行问题与启用选择。`retry` 移除完整层，等待清理，再将其加入；仅保留不变的行选项不会重启失败插件。`list` 从清单、静态声明和当前 Loader 状态派生每个包的视图。

**行通过 patch-file 写入器修改。** `setRowDisabled` 写入或移除 `disabled: true`，用户撤销禁用时恢复作者原来的条件。全局修改重组运行中的树。

**运行时通知跟随诊断。** 原生条目与 fiber 事件共用一次待完成的读取。读取等待 Loader 和 profile 重组完成，再比较行身份、模块、fiber 阶段、失败阶段与消息。只有诊断集合变化才发送原因是 `runtime` 的 `plugins/changed`；健康状态波动和重复的相同失败保持安静。管理操作仍保留自己的完成通知。读取期间到来的事件请求再次读取，适配器销毁时取消发布。

**取消是管理器操作。** 调用方生成的请求 ID 标识整次安装，贯穿其中的多次 pnpm 命令。`cancelInstall` 绕过修改互斥检查，只向匹配的安装发送取消信号，然后等待清理和锁释放。配置应用开始后关闭取消窗口。独立请求保留宿主的完成确认：只中止 add RPC 会让浏览器在文件恢复前停止等待。安装器复用 subprocess 的进程组管理，不另维护终止升级逻辑，也能在 runtime 启动前使用。

## Alternatives considered

**通过 `ctx.subprocess` 运行 pnpm。** 它的隐式环境清洗会移除 registry 凭据，也缺少本调用方需要的 Windows shell 模式。为安装包而扩展工具子进程服务会扩大无关接口。

**直接重启某个失败行。** 这会绕开整层组合，也无法顾及组合包中的 group 和覆盖。移除并重新加入层为其 Loader 条目提供完整生命周期。

**把业务操作保留在 Web 宿主或 app-boot 入口文件。** 宿主会成为 CLI 依赖；把安装、流式输出与依赖查询放进 boot 入口则会让每个启动器耦合管理实现。独立的 boot 组包同时服务两类消费方。

**每次 fiber 状态变化都广播。** 大部分变化不改变插件诊断。无条件通知会让客户端在无关工作期间重新读取包文件并渲染。比较诊断仍能报告失败发现与恢复；显式管理操作已经会报告自己的变更。

## Consequences

实时 profile 支持不重启地修改组合包与行。模块代码更新仍需重启，因为 Node 会缓存 ESM 模块。`dependents` 报告注入关系，不报告任意应用依赖，`engines.dsh` 仅供参考。运行时通知不保证描述每一次健康的配置文件修改；它报告诊断变化，操作通知则报告管理变更。

## Testing

管理器集成测试使用真实 profile 文件和原生 Loader 树；CLI 测试覆盖共用安装器。适配器测试覆盖 Remote 转接、失败变化与恢复、不变诊断不发通知、事件突发期间共用一次读取、profile 重组屏障以及等待期间的销毁。
