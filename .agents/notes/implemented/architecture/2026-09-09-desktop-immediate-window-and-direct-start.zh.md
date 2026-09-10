# Agent Note: Show the Desktop window before starting the Host

Status: implemented

[English](2026-09-09-desktop-immediate-window-and-direct-start.md) | 中文

本记录中的 profile staging、目录切换恢复和自动回滚由[直接修改 profile 决策](2026-09-09-desktop-in-place-profile.zh.md)取代。其他决策继续有效。

## 问题

等待后端就绪会让用户在准备 profile 和加载模块期间看不到窗口。完整的 staging 健康检查进程会在应用启动服务进程前重复启动后端，而插件在实际服务进程中仍然可能启动失败。

## 决策

Electron 在协调 profile 或启动 Host 前，先创建显示本地加载页的主窗口。该页面只依赖打包的壳资源，并通过受控 preload 接收 starting、ready 或 error 状态。就绪后在同一窗口加载产品 UI；实际启动失败时，在其中显示诊断和恢复操作。加载期间关闭应用会取消后续启动工作，并等待正在启动的子进程退出。

主窗口负责恢复，因为故障 Host 无法提供自己的操作界面。每个错误页保留诊断，提供重启、禁用第三方插件和重置 Desktop 三个操作，以及重装提示。所有操作均不依赖错误分类而保持可用。重置删除 profile 内除当前持有的锁之外的全部内容，不留备份；共享产品数据和 Harness home 环境文件保持不变。锁位于 profile 内，重置保留目录，防止其他事务在清理期间取得替代锁。没有启用第三方 bundle 时，已禁用插件的文件不能阻止启动。独立内嵌错误页通过拦截表单导航执行恢复，因此 preload 故障不会使按钮失效。

profile 激活在记录式目录替换后启动实际 Host。Desktop 不会另行启动并停止一个健康检查后端。依赖元数据与依赖图验证、经过审查的生命周期构建、运行时身份检查、事务锁和 profile 回滚仍然保留。实际启动失败可以恢复旧 profile；回滚不能撤销插件副作用或持久 Session 写入。

本决策部分取代[打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)和[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)中的 staging 后端探针与延迟创建主窗口。这两份记录仍保留发布、签名、传输、资源归属与依赖事务的理由。完整运行时文件验证仍属于打包操作。

## 考虑过的替代方案

**保留完整 staging 健康检查。** 它可以在替换活动 profile 前拒绝启动失败，但会执行两次插件初始化，也不能保证后续服务进程能够启动。实际启动结果与记录式回滚无需额外探针即可提供恢复能力。

**在就绪前隐藏主窗口。** 这避免显示加载页，但后端加载期间用户看不到进度，也无法交互。壳拥有的页面可以在 Host 启动失败时继续使用。

## 后果

产品 UI 可用前，用户就能看到启动进度并从失败中恢复。窗口可响应并不表示后端已就绪，启动延迟仍需测量安装产物。激活可能在替换 profile 后失败；事务日志保留 profile 文件的恢复能力。

验证覆盖 Host 延迟时可见的加载页、新 profile 只启动一次服务进程、同一窗口中的失败与重试、恢复期间的插件管理，以及子进程正在启动时关闭应用。安装后 GUI 证据补充生命周期与事务测试。
