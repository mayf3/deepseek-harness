# Agent Note：当前 profile 插件管理共享 CLI 事务

Status: implemented

[English](2026-09-14-current-profile-plugin-management.md) | 中文

## 问题

Web 和 Agent 控件需要修改运行中的 profile，同时避免另建包安装器或覆盖用户编写的 YAML。文件监听器可能读到安装期间写入的中间 manifest，也可能在被删除插件尚未释放资源时报告成功。

## 决策

[插件管理器](../../../../packages/boot/plugin-manager/README.zh.md)与 `dsh plugin` 调用同一套异步包操作。launcher 通过纯数据 `ctx.profileContext` 提供 profile 与解析位置、启动时组合包和调用级 overlay。共享函数组合当前文件；该接口不包含回调或修改方法。CLI 与 service 修改持有 profile manifest 的写锁；[DSH HMR](../../../../packages/boot/hmr/README.zh.md) 通过同一队列串行执行模块替换、Include 刷新、profile 重新组合与 service 修改。HMR 在自身初始化时注册 profile 监听与 `hmr/before-reload` 文件锁包装，等待应用就绪后再处理编辑。最终 YAML 组合决定是否运行 HMR，启动器不安装回退实例。包修改在 `hmr.runExclusive()` 内获取同一文件锁。每次重载重新读取 manifest、组合包层与用户 patch，同时保留调用级 overlay 的优先级。

profile 文件保持为持久状态：条目开关只修改 YAML 文档中的 `disabled`，组合包开关修改有序字符串列表。更新依赖不会重新激活保留的已停用组合包。service 删除组合包时，先应用去掉该组合包的配置，等待旧 fiber 完成卸载后再删除依赖。已保存配置、pnpm 完成状态与运行时激活分别报告；失败保留实际的部分状态与诊断路径。

这扩展了[profile 组合包决策](2026-08-05-profile-plugin-bundles.zh.md)。startup profile 保留进程组合，Desktop 包管理仍由 shell 持有。Web 控件与显式启用的 Agent 工具调用同一 service；service 合并持久通知，告知存活 Agent 而不唤醒它们。base 组合包和内置预设默认禁用该 Agent 工具。纯浏览器 worker 预览没有宿主包安装器；其模块代理表明确拒绝 `execa` 调用，同时保留管理模块用于清单发现。

## 考虑过的替代方案

**由 service 启动另一个 dsh 进程。** 这会重复生命周期协调，也无法确认当前 Loader 已完成卸载后才让 pnpm 删除文件。共享操作模块保留单一实现，同时让调用方持有各自的呈现方式。

**第二份目标状态数据库或自动回滚。** 这些方案需要将包管理器副作用与另一份状态同步。profile 文件保持可检查、可修复；安装与加载的部分失败直接报告，不用不完整的回滚掩盖。

**包更新时热替换源码模块。** 配置变化可以复用已加载模块缓存，替换已安装 JavaScript 则需要新的进程。替换已有依赖会报告需要重启。

## 影响

同一 profile 可以通过 CLI、Web 和工具管理，操作通过文件锁协调并保留 patch 优先级。运维人员需要根据报告的文件和诊断修复失败的包操作。startup 进程必须先停止，才能通过 CLI 删除其加载的包。管理组件受保护，不能通过 service 删除。
