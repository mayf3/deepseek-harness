# Agent Note：插件管理器驱动 profile runtime

Status: implemented

[English](2026-09-04-plugin-manager-over-the-profile-runtime.md) | 中文

## 问题

安装插件曾是只有终端能做的事：`dsh plugin --profile web add <spec>` 运行 pnpm，把找到的每个组合包追加进 `dsh.profile.bundles`，下次启动再组合。运行中的任何东西都无法得知哪些包装了但没启用，无法不手改 `package.json` 就关掉一个组合包，无法把某个包的模块加进 profile 的用户层或某个 agent preset，也说不出一个包的服务撑着哪些行。Web 界面能经 `pluginInventory/list` 列出行，仅此而已；而 launcher 的 `profileRuntime`（前一篇笔记）已经能在用户 patch 重载时重新组合树，`reconcileInstalledBundles` 也已经把安装与启用分开。缺的是执行这些操作并把每个包报告成一个整体的宿主服务。

## 决定

**一个服务，一份 manifest。** `dsh-host-plugin-manager` 提供 `pluginManager` 与 `plugins` Remote：`list`、`add`、`uninstall`、`enable`、`disable`、`retry`、`addRow`、`removeRow`、`setRowDisabled`、`dependents`。安装动词与 CLI 一样是 `add`：客户端的命名空间服务把 `install` 与 `remove` 留给自己的成员，挂载会拒绝同名方法。每个操作都重新读取 profile manifest，并通过 CLI 所用的同一组 app-boot 助手——`reconcileInstalledBundles`、`enableBundle`、`disableBundle`——写回，因此 CLI 与管理器不可能对这个文件有分歧：`dependencies` 说装了什么，`dsh.profile.bundles` 说启用了什么。profile runtime 按调用解析而非注入，于是 web 组合包的这一行在不经 profile launcher 启动的组合里也能启动，并回答 `plugins/unavailable`。

**启用就是 Loader 的事务。** `enable` 把组合包放进层列表，在 `healProfilesModuleFallback` 链接好该组合包携带的包之后调用 `profileRuntime.recompose({ reloadBundles: true })`。被拒绝的重新组合——`boot` 阶段而行抛错的组合包——就是 Loader 回滚到原本运行的树；管理器恢复层列表并报告 `plugins/enable-failed`。`runtime` 阶段而行失败的组合包由受控组隔离并逐行报告。由于启动审计不会再跑一次，管理器在在线重新组合之后调用 `recordContainedStates`，而 `ContainedGroup.create` 现在把以 pending 状态完成创建的行记录下来而不是清除——重载会重新创建组里的每一行，等待中的行必须带着记录穿过这一过程。`retry` 是先停用再启用：Loader 的更新不碰未改变的行，只有离开再回来才能重启一条失败的隔离行。

**pnpm 按 CLI 的方式运行。** 经 `node:child_process`、带父进程环境、Windows 上开 `shell`，而不经 subprocess seam：seam 会清洗 pnpm 访问 registry 与代理所需的形似密钥的变量，也没有解析 `.cmd` shim 的 shell 模式。输出以某个 job id 下的 `plugins/install-log` 分块流式发出；非零退出、spawn 错误或超时即带日志尾部的 `plugins/install-failed`。新包被探测并保持停用，除非调用方要求 `enable`。

**行经补丁文件写入器落地。** `addRow` 把 `{ id, name, config }` 插入 profile 的 `cordis.patch.yml` 或某个 agent preset 的用户层（经 roster 的 `overlayPathFor`），id 由包名与子路径派生；`setRowDisabled` 只写拒绝，写入或移除 `disabled: true`，因此组合包的 `!!js` 门被恢复而不是被覆盖。全局层当场重新组合；preset 的层在其下一个常驻代际生效。

**每个包一份视图。** `list` 把 manifest、探针记录（缓存在 `.dsh-plugins/` 下，版本变化即刷新）与在线树折叠成一个 `status`：按活跃行数是 `running`、`partial` 或 `failed`；`disabled`；带探针原因的 `not-enableable`；`startup` 重载的 profile 上 manifest 与树不一致时是 `restart-required`；库或插件模块是 `plain`。行在已组合时来自树，否则来自探针，并已带上 launcher 将使用的前缀 id；树外组合包的 trust 来自 `layerTrust`，这也是 `loadProfile` 所用的同一条规则。

## 考虑过的替代方案

**经 `ctx.subprocess` 运行 pnpm。** 本次否决：seam 没有 shell 模式且会清洗环境；为一个调用方给 seam 加上两者，比管理器本身改动更大，而 CLI 的 spawn 已被验证。

**`retry` 时原地重启失败的行。** 否决：行的 options 未变，Loader 的事务性更新不会碰它；手工重建一行会绕过组自己的创建路径及其失败记录。

**不探测就启用组合包。** 否决：正是探针把无法 import、或解析到自己那份 cordis 副本的包，在树被要求挂载之前变成带原因的 `not-enableable` 视图。

## 后果

运行中的 Web 宿主可以在 live profile 上不重启地安装、启用、停用、重试与移除三方组合包，并把它们的模块加进全局层或某个 preset。更新已加载的包仍需重启（Node 的模块缓存）；`dependents` 止于注入边；`engines.dsh` 只报告不强制；客户端 UI 在后续 PR 到来。

## 测试

`packages/host/plugin-manager/tests/plugin-manager.spec.ts` 经 `boot()` 启动一个临时 profile，带上 launcher 提供的 profile runtime 与一个按真实 pnpm 的方式编辑 manifest 的假 pnpm：视图折叠（已安装、已启用、已探测、等待中、用户停用、一方包、手写 manifest），带与不带启用的安装及其失败（退出码、spawn 错误、超时、日志尾部），live 与 `startup` profile 上的启用与停用，boot 阶段的回滚，不稳定隔离行的重试，全局层与 preset 层里的行及其冲突，按提供服务与按用户层引用的依赖检测，以及卸载。`packages/boot/app-boot/tests/contained-group.spec.ts` 钉住等待中的行记录跨重载保留。
