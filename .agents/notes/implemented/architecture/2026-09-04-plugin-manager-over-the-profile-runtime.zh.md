# Agent Note：插件管理器驱动 profile runtime

Status: implemented

[English](2026-09-04-plugin-manager-over-the-profile-runtime.md) | 中文

本文中的启用事务、contained 失败记录和执行 probe 已由[原生条目诊断与静态声明](2026-09-11-native-entry-diagnostics-and-static-plugin-declarations.zh.md)取代。管理器与 Remote 的拆分、pnpm 进程选择、修改互斥和 patch 文件归属仍然适用。

## 问题

安装插件曾是只有终端能做的事：`dsh plugin --profile web add <spec>` 运行 pnpm，把找到的每个组合包追加进 `dsh.profile.bundles`，下次启动再组合。运行中的任何东西都无法得知哪些包装了但没启用，无法不手改 `package.json` 就关掉一个组合包，无法把某个包的模块加进 profile 的用户层或某个 agent preset，也说不出一个包的服务撑着哪些行。Web 界面能经 `pluginInventory/list` 列出行，仅此而已；而 launcher 的 `profileRuntime`（前一篇笔记）已经能在用户 patch 重载时重新组合树，`reconcileInstalledBundles` 也已经把安装与启用分开。缺的是执行这些操作并把每个包报告成一个整体的宿主服务。

## 决定

**一个管理器，一个 Remote。** boot 组里与 `app-boot` 并列的 `dsh-plugin-manager` 拥有插件管理做什么：`PluginInstaller` 只需要磁盘上的 profile（pnpm 运行、探针、装后检查），`PluginManager` 在其上加上已启动树的每项操作，每次拒绝都是带 `plugins/*` 码的 `PluginOperationError`。`dsh-host-plugin-manager` 提供 `pluginManager` 与 `plugins` Remote——`list`、`add`、`uninstall`、`enable`、`disable`、`retry`、`addRow`、`removeRow`、`setRowDisabled`、`dependents`——作为转接层：一个 Remote 方法对应一个管理器方法，一个穷尽的 switch 把失败转成同码的 Remote 错误（`plugins/bad-request` 转成 Gateway 的 `gateway/bad-request`）。管理器把 profile runtime、preset roster 与运行中 agent 数当作按调用读取的读取器接入，roster 只以 `PresetLayers`（层路径、preset 列表、组合行）的形态接入，因此既不依赖 roster 也不依赖 agent 注册表；`dsh plugin add` 与 `remove` 跑同一个安装器，CLI 与 Web 宿主共用一套准入规则，终端里不必启动 profile。每个操作都重新读取 profile manifest，并通过 CLI 所用的同一组 app-boot 助手——`reconcileInstalledBundles`、`enableBundle`、`disableBundle`——写回，因此 CLI 与管理器不可能对这个文件有分歧：`dependencies` 说装了什么，`dsh.profile.bundles` 说启用了什么。profile runtime 按调用解析而非注入，于是 web 组合包的这一行在不经 profile launcher 启动的组合里也能启动，并回答 `plugins/unavailable`。

**启用就是 Loader 的事务。** `enable` 把组合包放进层列表，在 `healProfilesModuleFallback` 链接好该组合包携带的包之后调用 `profileRuntime.recompose({ reloadBundles: true })`。被拒绝的重新组合——`boot` 阶段而行抛错的组合包——就是 Loader 回滚到原本运行的树；管理器恢复层列表并报告 `plugins/enable-failed`。`runtime` 阶段而行失败的组合包由受控组隔离并逐行报告。由于启动审计不会再跑一次，管理器在在线重新组合之后调用 `recordContainedStates`，而 `ContainedGroup.create` 现在把以 pending 状态完成创建的行记录下来而不是清除——重载会重新创建组里的每一行，等待中的行必须带着记录穿过这一过程。`retry` 是先停用再启用：Loader 的更新不碰未改变的行，只有离开再回来才能重启一条失败的隔离行。

**pnpm 按 CLI 的方式运行。** 经 `node:child_process`、带父进程环境、Windows 上开 `shell`，而不经 subprocess seam：seam 会清洗 pnpm 访问 registry 与代理所需的形似密钥的变量，也没有解析 `.cmd` shim 的 shell 模式。输出以某个 job id 下的 `plugins/install-log` 分块流式发出，每块写明命令行与 profile 目录，pnpm 的颜色为 Web 对话框的终端保留、对 stdout 不是终端的 CLI 去掉；非零退出、spawn 错误或超时即带日志尾部的 `plugins/install-failed`。新包被探测并保持停用，除非调用方要求 `enable`。

**`pnpm add` 成功不等于装好了插件。** 运行前先给 manifest 拍快照，pnpm 失败时恢复，失败的 add 不会留下依赖。之后逐个裁决 pnpm 加进来的包：既不声明组合包也不声明插件模块的，或者行 id 已被已组合层占有的组合包（对当前各层加候选层跑 `claimLayerIds`），再以 `pnpm remove` 移除并连同原因报在 `removed` 里；探针拒绝的包保留，因为视图能解释它、`retry` 还能再试。管理器一次只跑一个变更，第二个以 `plugins/busy` 拒绝而不是排队——否则每次写入都会在 manifest、用户层或 `node_modules` 上竞争——`add` 与 `uninstall` 在任一 agent 运行时以 `plugins/agents-running` 拒绝，因为 pnpm 会重写那些会话正在 import 的目录。这三道守卫来自社区的 `dshmarket` 管理器，它每一条都是从一个 bug 学来的。

**行经补丁文件写入器落地。** `addRow` 把 `{ id, name, config }` 插入 profile 的 `cordis.patch.yml` 或某个 agent preset 的用户层（经 roster 的 `overlayPathFor`），id 由包名与子路径派生；`setRowDisabled` 只写拒绝，写入或移除 `disabled: true`，因此组合包的 `!!js` 门被恢复而不是被覆盖。全局层当场重新组合；preset 的层在其下一个常驻代际生效。

**每个包一份视图。** `list` 把 manifest、探针记录（缓存在 `.dsh-plugins/` 下，版本变化即刷新）与在线树折叠成一个 `status`：按活跃行数是 `running`、`partial` 或 `failed`；`disabled`；带探针原因的 `not-enableable`；`startup` 重载的 profile 上 manifest 与树不一致时是 `restart-required`；库或插件模块是 `plain`。行在已组合时来自树，否则来自探针，并已带上 launcher 将使用的前缀 id；树外组合包的 trust 来自 `layerTrust`，这也是 `loadProfile` 所用的同一条规则。

## 考虑过的替代方案

**经 `ctx.subprocess` 运行 pnpm。** 本次否决：seam 没有 shell 模式且会清洗环境；为一个调用方给 seam 加上两者，比管理器本身改动更大，而 CLI 的 spawn 已被验证。

**`retry` 时原地重启失败的行。** 否决：行的 options 未变，Loader 的事务性更新不会碰它；手工重建一行会绕过组自己的创建路径及其失败记录。

**不探测就启用组合包。** 否决：正是探针把无法 import、或解析到自己那份 cordis 副本的包，在树被要求挂载之前变成带原因的 `not-enableable` 视图。

**把操作留在宿主包里。** 评审后否决：`host/` 是 Web GUI 的那一半，`dsh plugin` 命令要复用安装路径就只能依赖一个 Web 宿主包，于是它一直保留着自己的、没有装后检查的 pnpm 转发器。放进 `app-boot` 一个文件的变体也被否决：每个 `dsh` 表面启动时都加载 `app-boot`，上千行的 pnpm 流式输出、探测与依赖检测应该与它并列，而不是塞进它。

## 后果

运行中的 Web 宿主可以在 live profile 上不重启地安装、启用、停用、重试与移除三方组合包，并把它们的模块加进全局层或某个 preset。更新已加载的包仍需重启（Node 的模块缓存）；`dependents` 止于注入边；`engines.dsh` 只报告不强制；客户端 UI 在后续 PR 到来。启用、停用与行编辑不受运行中会话限制：它们重组的是树，那是 Loader 的事务，不碰 `node_modules`。

## 测试

`packages/boot/plugin-manager/tests/plugin-manager.spec.ts` 覆盖实际 profile 文件与原生 Loader 树上的管理操作。Host 适配器测试覆盖直接转接、错误码与依赖恢复通知；`apps/cli/tests/plugin.spec.ts` 覆盖共用安装器。生命周期与静态发现的验证遵循取代这些机制的新笔记。
