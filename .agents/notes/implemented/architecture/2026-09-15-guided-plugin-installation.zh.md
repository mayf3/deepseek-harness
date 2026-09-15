# Agent Note：引导式插件安装

Status: implemented

[English](2026-09-15-guided-plugin-installation.md) | 中文

## 问题

安装对话框把 spec 直接交给 `pnpm add`，并把 pnpm 的终端当作全部说明：打错字、已装过的包、不存在的路径、注册表不可用，最后都是同一个红色退出码，人得去读 pnpm 输出才知道是哪一种，而且一旦开始就停不下来。启用是一个在知道要装什么之前就得勾的选项，装完的包散在列表某处。会话运行中之类的拒绝会一直挂在页面上，直到手动关掉。

## 决定

**宿主先读 spec，再安装。** `PluginInstaller.inspect` 用 `parseInstallSpec` 把 spec 分成注册表名、绝对路径、git 地址、压缩包，拒绝 pnpm 或注册表不会接受的写法，再通过 `pnpm view` 问注册表、或读目录的 `package.json`，得到名字、版本、描述、标题和组合包声明。`pnpm view` 在 profile 目录里运行，让注册表和代理设置与安装一致。`plugins/inspect-rejected` 带六种 problem 之一；客户端把每一种渲染成输入框下的一句话，spec 保留可改。列表里已有的名字由对话框直接拒绝，不问宿主。

**失败在事实所在处分类。** `classifyInstallFailure` 依据运行的结束方式和 pnpm 的输出——它的 `ERR_PNPM_*` 码和 Node 的 errno 名——给 `plugins/install-failed` 加上 `kind`。客户端把 kind 显示成一句话，把 pnpm 输出折叠进详情。对日志的解析只存在于这一个函数，用夹具驱动的测试钉住。

**取消属于管理器，不属于信号。** 运行通过 `plugins/cancelInstall` 带上对话框生成的 request id 来停止，对话框等宿主答复之后才把 spec 重新交回；[管理器笔记](2026-09-04-plugin-manager-over-the-profile-runtime.zh.md)记录了为何中止 RPC 不算确认。只有检查末尾接受 `AbortSignal`：返回编辑或关闭会丢掉一次注册表查询，没有人等它的结果。

**启用在事后。** 完成画面为这次运行新增的组合包提供**立即启用**；对话框关闭，列表滚动到其中第一个。在人看到装了什么之前，不会启用任何东西。

**当下的拒绝是 toast。** `plugins/busy` 与 `plugins/agents-running` 让对话框回到输入并弹 toast；页面上其余提示也都是 toast。重启横幅保留，因为它描述的是状态而非事件。

## 考虑过的替代方案

**在客户端校验 spec。** 否决：规则属于 pnpm、注册表和 profile，客户端无法导入拥有这些规则的宿主包。

**用 HTTP 直接查注册表而不是 `pnpm view`。** 否决：决定安装能否成功的注册表、代理与认证设置都在 pnpm 的配置里，`pnpm view` 读得到，直接 fetch 得重新实现一遍。

**通过中止 add RPC 来停止运行。** 否决：断掉的 RPC 说不清 pnpm 是否停了、manifest 是否已恢复，对话框会在一次仍在写 profile 的运行之上把 spec 重新交回。管理器的 `cancelInstall` 只在清理完成后答复，对话框等它。

## 后果

Remote 新增 `plugins/inspect` 与 `plugins/inspect-rejected`；`plugins/install-failed` 增加 `kind`；宿主配置增加 `inspectTimeoutMs`。对话框是围绕同一张主题卡的四个画面。非插件包依赖分组默认折叠，并说明自己装的是什么。

## 测试

`packages/boot/plugin-manager/tests/install-spec.spec.ts` 钉住 spec 形式与失败分类器的输入；`plugin-manager.spec.ts` 用假的 `pnpm view` 和真实目录驱动 `inspect`，并检查每一种 kind；`packages/host/plugin-manager/tests` 连同信号转接 `inspect`。`packages/client/ui-plugin-manager/tests` 覆盖 store 的阶段、经宿主确认的取消、装后启用、toast 与页面的四个画面；`apps/web/tests/plugin-manager.e2e.ts` 经真实宿主拒绝已装名字、不存在的路径和坏名字，`plugin-install-cancel.e2e.ts` 从对话框停下一个真实子进程并拿回 spec。
