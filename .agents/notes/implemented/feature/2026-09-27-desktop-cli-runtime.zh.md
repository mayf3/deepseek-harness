# Agent Note: Desktop 安装的 CLI 运行时

Status: implemented

[English](2026-09-27-desktop-cli-runtime.md) | 中文

## 问题

Desktop 已携带 DSH 命令及其生产依赖，但终端使用仍需单独安装。CLI 命令的进程生命周期也可能长于 Desktop 窗口，因此替换共享应用文件必须考虑这些使用者。

## 决策

原生终端启动器通过已安装的 Electron 可执行文件以 Node 模式运行私有 Desktop CLI 入口。入口委托公开 CLI 分派器，保留普通 profile、参数、工作目录、环境、流与退出状态。它不启动 Desktop Host，也不复用其保留的 profile。

CLI 通过现有包操作配置提供随附 pnpm。其挂载前回调使用 Cordis 配置解析，仅在 Office 插件启用时提供物理 Office 资源。显式资源设置与 CLI 禁用选项保持优先。回调不添加 profile 行，也不重写用户配置。Desktop Host 启动与 ASAR 打包保留现有行为。

## 运行时使用与安装

每条命令在安装目录的租约文件上持有共享操作系统锁。原生更新控制器需要排他锁，因此运行中的命令会拒绝更新准备，新命令也无法在准备期间进入。Windows 在 CLI 子进程启动前将其纳入 job，转发控制台输入，并在释放锁前等待其剩余进程树结束。CLI 通过随附的 Koffi 库注册 Windows 控制台回调，在 JavaScript 线程上分派 SIGINT 和 SIGBREAK，使异步退出得以完成；否则 Electron 44 会在这些 JavaScript 监听器运行前走原生控制台退出路径。

GUI 将控制权交给原生更新器之前，控制器以原子方式将被替换的代际记录在应用外的同级文件中。该记录在 GUI 与控制器退出后仍保留，并且仅阻止旧代际。完整替换携带新的代际与租约 inode；不保留第二份运行时。取消只移除匹配的事务。GUI 退出之后若安装失败，需要重新打开 Desktop 并完成更新，旧代际的 CLI 才能再次运行。

更新协调器将该控制器作为可选安装依赖。控制器在原生安装程序启动前提交交接，并在准备被拒绝或失败后取消交接。安装身份独立于 DSH_HOME。启动检查会确认持有的租约仍属于当前安装。释放时等待进行中的 CLI 启动控制完成，取消尚未启动安装程序的交接，并阻止晚到的回调启动安装程序。

## 考虑过的替代方案

**再次通过 npm 安装。** 这会重复依赖树，并可能偏离 Desktop 版本。

**独立 Node 与外置包树。** 普通 Node 无法加载现有 ASAR 树。迁移它会改变 Desktop 打包与数千个文件系统条目；本功能保留现有应用。

**向 Desktop Host 转发命令。** Host 持有不同的 profile 与 IPC 生命周期，而终端命令必须在 GUI 关闭时仍可使用。

**仅检查进程快照而不锁定启动。** 快照完成后仍可能有命令启动。仅由 GUI 持有的锁也会早于异步原生安装程序结束。

**保留旧运行时版本。** 这允许并发替换，但增加了本安装不需要的载荷保留与清理。

## 后果

命令的运行时版本随 Desktop 更新。[Electron 运行时决策](../architecture/2026-09-11-desktop-electron-node-runtime.zh.md)继续说明 Electron/OpenSSL 与第三方原生 addon 的限制。[主运行时](2026-09-14-desktop-primary-runtime.zh.md)提供 Office 所需的独立 Node 可执行文件，无需新增载荷。

原生命令测试覆盖流、参数引用、退出状态、并发 CLI 使用者、准备取消与代际交接。Office 覆盖使用真实 Loader，并检查显式配置、重载与 dispose。打包后的原生功能与平台签名验证仍属于发布要求。
