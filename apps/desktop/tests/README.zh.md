# Desktop 本地更新验证

[English](README.md) | 中文

## 概述

截至 2026-09-14 的 Windows 工作区验证记录。本地下载和强更弹窗证据与生产后端联调、视觉验收、已安装应用升级分开记录。运行 [Desktop README](../README.zh.md) 中的命令可生成新的隔离报告。

已安装应用验收可显式启用 `DSH_DESKTOP_UPDATE_JOURNAL_DIR`，使用安装目录树之外、两个版本共同保留的绝对路径。每个主进程将已安装版本、状态转换和人工操作标记刷新到单独的 JSONL 文件。原始诊断和请求数据被排除；存储错误会向上传播。[日志决策](../../../.agents/notes/implemented/testing/2026-09-14-desktop-installed-update-journal.zh.md)定义证据的局限。单元与主入口测试覆盖该日志；签名安装版升级仍未验证。

## 目录

- [验证证据](#verification-evidence)
- [手动演练](#verification-interactive)
- [待验证事项](#verification-open)
- [开发备注](#verification-dev-note)

<a id="verification-interactive"></a>

## 手动演练

实际安装、启动后发布、失败重试与重启证据使用[已安装应用更新人工清单](installed-update/README.zh.md)。下方交互式运行器拦截安装，属于另一类验收。

Host、客户端与 Desktop 产物构建完成后，在 Windows 仓库根目录运行 `node --import tsx apps/desktop/scripts/test-workspace-updates.ts --interactive`。真实工作区持续打开，并提供独立控制窗口。其菜单可选择普通或强制更新、保持和放行下载、注入下载失败，以及添加或清空测试任务。失败模式须在开始下载前选择。确认安装并完成任务收尾后，fixture 消息提示安装器调用已被拦截；确认消息结束演练。关闭控制窗口也会退出。每次运行独占私有 profile 和回环服务器；载荷不是安装器。重新运行命令开始新一轮。省略 `--interactive` 则运行自动化场景，保留 120 秒截止时间和自动退出；交互模式下载的网络截止时间为十分钟。

<a id="verification-evidence"></a>

## 验证证据

本地命令构建 Desktop，并在 Electron 44 中运行真实 HTTP updater、策略客户端、沙箱预加载和强更页面。它记录每个场景，并把报告保存在 `.desktop-build/qualification/local-updater-*`。安装器调用、外部浏览器和剪贴板均替换为观测记录；下载字节不是可执行安装器。

| 层次 | 观测结果 |
|---|---|
| 常规 updater | 同版本／旧版本拒绝、用户授权完整下载、SHA-512 拒绝、传输中断、清单／下载停滞截止时间、显式重试、请求合并、同地址清单替换、就绪状态和独立安装交接通过 |
| 强更策略 | 扁平化 `40005`、完整发布头、游客请求、无需强更验证、失败保留、间隔／退避、超时和 dispose（资源释放）回归通过 |
| 常规调度 | 真实协调器配合模拟时钟的回归验证有上限的抖动／退避、手动复用、成功重置、不自动重试下载、不受系统时钟调整影响，以及 dispose。主入口测试验证聚焦／恢复节流、显式检查立即执行和退出清理 |
| 真实强更窗口 | 服务端纯文本内容、关闭／Esc 拦截、直接下载、同弹窗任务确认、稍后更新、仅恢复态页面操作、导航／复制反馈和新策略解除通过 |
| 真实常规弹窗 | 隔离预加载、380px 卡片、24px 圆角、黑色主按钮、父窗口模糊、Esc 取消后保留就绪，以及任务警告批准后的安装交接记录均通过 |
| 解锁后的 Windows 交互 | 对真实强更页面执行系统级点击并截图，确认关闭／Esc 阻塞、用户发起下载、就绪、红色策略错误提示，以及弹窗解除后父窗口恢复可用。fixture 提供的原生任务警告弹窗在选择稍后更新后回到就绪态；任务活动为模拟，不是完整 Host 工作负载 |
| 主入口 | 已知阻塞拒绝插件修改和恢复，但不停止 Host；新成功响应关闭阻塞；打包策略忽略环境覆盖；正常停止后的安装器失败在下次确认前恢复 Host，并保留强更阻塞 |
| Host 任务保护 | 替换组合环境后的真实控制器识别运行中的 agent、排队的 turn／step、全局和 agent job；API 读取不触发警告。请求准入锁定向新请求返回 503，等待已有请求结束并复查任务；解锁恢复准入 |
| 可见输出 | 中文强更弹窗 DOM 预期输出和常规更新展示预期输出通过；账户行组件测试覆盖进度和持久重试 |
| 打包配置 | 元数据嵌入配置的应用 ID 和策略；构建后的打包前钩子拒绝 HTTP 策略源站，不执行打包或上传 |

弹窗、主入口、设置和侧栏的定向运行通过 119 个回归用例。五个载体测试覆盖共享更新状态源的全部语句、分支、函数和代码行。真实 Electron 命令通过 17 个场景，并捕获常规就绪、任务警告和强更错误弹窗。这些隔离检查不认证完整工作区或发布。全仓门禁结果及环境限制与这些定向证据分开记录。

Chromium headless shell revision 1228 已安装在忽略目录 `.desktop-build/playwright` 中。组装后的设置和侧栏浏览器套件通过 18 个用例。[Desktop 工作区浏览器场景](../../web/tests/desktop-updates.e2e.ts) 的中英文用例均通过，每种语言捕获六张截图，并验证底部账户行位置、紧凑进度及重复点击拦截、顶部展开按钮提示、带错误悬停详情的持久红色重试，以及独立的就绪操作。展示函数、Host Web 组合、客户端插件和 CSS 均为真实实现；Desktop 载体使用替身。这些用例不执行 Electron IPC、菜单、任务授权或安装。

[构建后 Host 场景](fixtures/host-update-qualification.mjs) 使用真实 profile Loader、standard agent 预设、任务服务和 Node 后台进程。它验证排队的轮次／步骤、运行中的模型请求、等待答复的提问／审批、运行／停止中的全局和 agent job、不会取消任务的准入锁定、准入恢复，以及 Host 释放后的检查拒绝。仅模型响应和人工答复使用替身。两个独立调用使用私有 profile 和会话数据并发通过；全部自有 agent、job 和 Host 完成后才写入成功报告。

[Electron 工作区运行器](../scripts/test-workspace-updates.ts) 在私有目录中执行编译后的主入口，使用真实预加载、工作区和独立 Host 进程。它确认首次启动声明，并通过 Electron 输入事件操作页面按钮。十个场景通过，覆盖菜单反馈、下载失败与重试、独立安装确认、确认期间真实任务创建、推迟安装、强更阻塞和真实 Host 停止超时。普通与强更失败均恢复替代 Host，并要求重新确认安装；恢复不会清除强更策略。分发使用本地服务器，安装被拦截；这些不是签名已安装应用的验证结果。

[Windows 验签运行器](../scripts/test-windows-update-signature.mjs) 使用已安装的 electron-builder 元数据生成器和 `NsisUpdater` 验签器，输入为公开发布证书和真实可执行文件。发布者属性匹配时通过；同一有效签名在预期发布者不同时被拒绝，未签名可执行文件也被拒绝。缺少发布者的负对照确认验签被跳过。单元回归覆盖 DN 转义、不完整身份，以及显式或宿主默认 Windows 目标；移除发布者配置会使两条元数据用例失败。此检查不下载、安装或签名产物。

[签名下载运行器](../scripts/test-signed-updates.mjs) 连接真实 Electron HTTP、`NsisUpdater`、Windows Authenticode 和构建后的协调器。四个场景通过：哈希正确但发布者错误时拒绝、哈希正确但未签名时拒绝、传输损坏先于验签被拒绝，以及显式重试后签名文件就绪并单独交接安装。被拒绝的可执行文件缓存为空，自动检查不发送重试请求，已准备的下载保持可用，原始输入的 SHA-512 不变。合成清单和测试应用适配器不证明已安装版本兼容性；不会启动安装器或 Host。

提供旧安装器和两个原始 blockmap 后，同一运行器还会验证单段 Range、多段 Range 重建、缺少旧 blockmap 时回退，以及 Range 被拒绝时回退。重建的可执行文件通过 SHA-512 和 Authenticode 检查。请求记录区分差分负载字节与全量下载；全量回退不能满足差分成功断言。这些回环结果不证明 CDN Range 支持或已安装应用的缓存可用。

<a id="verification-open"></a>

## 待验证事项

以下事项不是通过证据，review 时必须保持可见：

- Electron `capturePage()` 捕获单个窗口。Windows 交互观测包含合成弹窗和原生菜单选择，但跨平台 Figma／布局验收与完整录制仍未验证。自动化工作区运行器直接调用菜单处理器。
- 开发启动器在此 Windows 工作区遇到指向缺失目标的可选 Linux ARM64 依赖 junction；验收运行器直接链接已有依赖图，不验证该启动器的依赖投影。
- fixture（测试前置数据）不执行安装器，不覆盖已安装应用，也不证明新版本成功启动。发布前仍需签名 Windows 和 macOS 的已安装版本验收。
- 两个隔离 Windows 测试安装包通过签名包检查，包括内嵌清单配置。安装后启动、失败重试、自动重启和数据保留仍待操作者验证；文件检查不认证发布。
- 真实策略源站、网关行为、限流、批准的页面源站和已部署策略配置仍待后端联调。本地响应不能证明线上服务可用。
- 策略、updater 清单与下载停滞均达到真实截止时间并可恢复。下载写入的 `ENOSPC` 故障注入已覆盖；真实卷耗尽与已安装版本升级的磁盘压力仍未验证。差分下载和发布者拒绝已通过真实 Electron 下载验证，但尚未在新打包应用的已安装版本升级路径中验证。
- Windows 原生剪贴板写入通过。已尝试启动默认浏览器，但因自动化工具无法可靠识别当前 URL，目标地址验证停止。macOS 浏览器和剪贴板集成仍未验证。
- 强更与常规失败使用本地化摘要和折叠诊断；复制失败展示可选择的地址。常规错误悬停提示显示摘要，不展示原始诊断。Windows／macOS 安装包的图标提醒、通知权限与专注模式行为仍未验证。
- 完整 `doc-sync`（文档同步门禁）在文档站测试中遇到 Windows 文件符号链接 `EPERM`。这不是 updater 失败，也不代表完整文档门禁通过。

<a id="verification-dev-note"></a>

## 开发备注

2026-09-15 的完整工作区运行 `electron-workspace-updates-OwsLMP` 使用真实 Electron、预加载和 Host 进程，拦截安装器，通过十个场景。它检查普通下载错误仅在初始折叠的详情中保留原文、任务变化提示不被错误摘要覆盖，以及收尾期间安装提示持续可见而不显示重连文案。普通与强更停止失败后的恢复均通过。截图 `installing-before-host-exit.png` 记录主窗口状态；这不认证独立安装器或随后启动阶段的 GUI。

2026-09-15 的本地运行 `local-updater-Y770Uz` 通过 17 个真实 Electron 场景，没有执行安装器。普通错误截图和 DOM 断言验证诊断默认折叠、展开文本完整、详情区域最高 180 CSS 像素且可滚动，以及 1,000 行诊断下确认按钮仍可见。这不认证跨操作系统的小窗口或已安装应用布局。

TODO（暂缓实施的桌面体验）：从确认安装到新工作区可用，提供连续状态反馈。旧应用说明任务收尾，旧进程退出后由安装器展示进度，新应用展示启动状态。仅对可测量的安装工作显示真实百分比，任务收尾和启动使用不定进度反馈；不增加确认操作。优化耗时前补齐安装器交接、文件替换、进程启动和窗口首次可见的时间戳。这是待办，不是已实现行为，也不属于本轮错误文案与发布流程修复。

2026-09-14，经操作者授权的构建在 `.desktop-build/qualification/installed-update-r5dYNH/` 中生成签名 `0.1.6-nightly.20260914.1` 和 `0.1.6-nightly.20260914.2` 安装包，两者共用私有身份和 test feed。每次受监督构建记录 15 次成功签名，没有签名失败；此计数不测量令牌内部认证次数。版本目录内的 `verification/check-KaQ0AB/result.json` 和 `verification/check-nO2tMM/result.json` 通过真实 updater／Authenticode 验签、时间戳、归档路径、冻结应用字节、运行时内容及内嵌更新设置检查。安装包分别为 155,855,536 和 155,854,520 字节。保留的授权和事故归档记录了基于成功单文件探针的软件保护锁恢复；当前令牌登录状态和剩余次数没有查询。上述构建与检查没有执行安装器或写入远端 feed。这些本地回执验证文件，不证明已安装版本升级成功。 此处 Nightly 版本号仅标识历史验收物料；新发布使用[发布版本规则](../README.zh.md#release-versions)。

2026-09-14 的 `local-updater-k1Sbo5` 通过 17 个真实 Electron／本地服务器场景，包括同弹窗安装确认和稍后更新。完整工作区报告 `electron-workspace-updates-7J0rLB` 记录了使用编译主入口、真实 preload 和真实 Host 进程的 10 个场景，包括强更停止任务失败及恢复。两次运行均不执行安装器。八个定向套件通过 94 个回归，覆盖强更渲染、版本绑定批准、过期 frame 拒绝、剪贴板失败、任务恢复及 Windows／macOS 单次提醒适配器。这些替身不认证原生通知展示。

2026-09-11 以 test 配置执行 `pnpm run package:desktop:win:x64`，正式构建、原生载荷检查和隔离运行时 Host 冒烟测试通过。`0.1.5-rc.2` 运行时记录协议 4、Node `24.18.1`、pnpm `11.7.0`、241 个共享包和 11,212 个文件。首次签名操作以 `No private key is available` 失败；命令退出码为 1，排队操作沿用该失败，不再尝试签名。没有生成安装器、发布记录或 `app-update.yml`。未完成的 `app.asar` 包含 `com.deepseek.dsh`，没有强更策略。报告 `.desktop-build/qualification/windows-package-20260911-*.json` 记录此次尝试和其他任务尚未提交的载荷冒烟测试输入。没有上传或安装；传入的 test 源站不等于最终产物已验证。

合入薄 Web 基线 后，Desktop 和 Host 的 TypeScript 构建与打包通过，配置管理、包准备、启动和任务保护的 79 个定向测试也通过。`host-updates-3u05JI` 通过十二项真实 Host 观测；`electron-workspace-updates-4Xh5ts` 使用共享 Web 配置默认值，通过十个编译主入口场景。两次运行均正常退出，未执行安装器。这些报告验证合并后的配置组合，不认证签名已安装版本升级。

并发运行 `local-updater-76Tj0v` 和 `local-updater-NsoFtx` 各通过十七个场景，包括部分写入后的 `ENOSPC`、缓存清理、拒绝安装、持续重试入口和恢复下载。使用原始写入器的负对照以 `ready !== error` 失败，随后恢复故障注入。较早的对照保留短写但不注入错误，达到运行器截止时间，不能作为成功证据。没有填满真实卷，也没有执行安装器。

Windows 交互运行 `native-workspace-updates-2ITSmL` 使用编译主入口、真实共享 Web Host、原生菜单选择和操作系统点击，观测直接下载、哈希拒绝、显式重试、进度、独立就绪确认、推迟安装、收起侧栏标记及强更阻塞。保留的三张 `native-*.png` 截图展示完整就绪／强更窗口和收起侧栏。真实剪贴板内容与配置的测试 URL 相同。浏览器目标地址验证被自动化工具中断，不算通过。合成 updater 版本为 `0.1.5-rc.1`，未打包外壳则报告 Electron `44.0.0`，因此不作为已安装版本证据。显式关闭 fixture 后正常退出，没有安装调用，并保留 `native-runtime-result.json`。私有驱动和截图是本地辅助资料，不是自动化 CI 场景。

薄 Web 基线的验证与下方历史报告分别记录。并发内置 Host 运行 `host-updates-8pqnUP` 和 `host-updates-ZwYzBa` 通过十二项观测，包括真实 HTTP 读取不触发任务警告且等待其结束，以及已接收写操作创建的排队任务在请求结束后被检测到。编译主入口运行 `electron-workspace-updates-HCWgwA` 使用共享 Web Host 和 Electron Node 运行时，通过十个场景，包括普通与强更停止失败后的恢复。安装仍被拦截；单窗口截图不认证操作系统合成效果。

2026-09-11 的 test 部署报告位于 `.desktop-build/qualification/` 下的 `cdn-test-upload-report.json` 和 `cdn-test-download-report.json`，记录隔离 COS 上传、同址清单替换、updater 读取、60 字节下载与 SHA-512 匹配，以及 `download-test.deepseek.com` 正确的 HTTP 206 Range 响应。清单响应使用 `max-age=0`，载荷使用 `max-age=86400`。远端探针对象保留。这些仅是传输证据：没有执行安装器，也没有验证发布者签名。

在签名下载命令后追加 `<old.exe>` 可启用四个差分场景；输入安装器旁必须存在 `<signed.exe>.blockmap` 和 `<old.exe>.blockmap`。2026-09-11 的 `signed-downloads-roqKBc` 使用私有缓存中的 `0.1.2-rc.1` 副本，重建 190,511,600 字节的签名 `0.1.3-alpha.1` 安装器，两种 Range 模式均下载 122,242,722 个负载字节，不含 blockmap 和多段响应封装。两种回退场景均下载完整负载。并发运行 `signed-downloads-HXCCYB` 与 `signed-downloads-MWpDAQ` 在 UTC 08:11:09 至 08:11:37 重叠，各通过八个场景。负对照 `signed-downloads-XcCPuf` 禁用差分下载，虽达到签名就绪，仍因 blockmap 请求断言失败；fixture 设置已恢复。报告记录这些运行均正常退出，未触发截止时间；运行时目录在退出后移除。

2026-09-11 的 Windows 准备流程生成 `0.1.5-rc.1` 运行时，清单包含 11,213 个文件和 241 个共享包。对该目录独立执行 `verifyDesktopRuntime` → `smokeDesktopRuntime` → `verifyDesktopRuntime` 通过：隔离 profile 启动真实 Host、提供前端服务并停止。原准备进程已经退出，但其终端结果不可用；本记录依据独立检查，不宣称原命令的退出码。这是资源准备，不是新签名包或已安装版本升级。

Desktop 产物已构建时，在 Windows 仓库根目录运行 `node apps/desktop/scripts/test-signed-updates.mjs <public.cer> <signed.exe> <unsigned.exe>`。报告保留在 `apps/desktop/.desktop-build/qualification/signed-downloads-*`，运行时缓存在子进程退出后移除。默认截止时间为 180 秒；`DSH_SIGNED_UPDATE_TEST_TIMEOUT_MS` 接受 1000–180000 毫秒，用于验证运行器失败。并发运行 `signed-downloads-JBJCU8` 和 `signed-downloads-N4D01x` 在 2026-09-11 的 UTC 07:52:30 至 07:52:38 重叠，各通过四个场景。1000 毫秒对照 `signed-downloads-L6rrcn` 记录超时和退出码 1；`signed-downloads-uxgcmk` 因缺少发布者元数据错误进入就绪而失败。这些运行结束后，关联进程和运行时缓存均不存在。测试使用历史产物字节及合成的 `1.0.0`／`1.0.1-nightly.1` 应用／清单版本，不是可发布的版本组合。

在已安装依赖的 Windows 仓库根目录运行 `node apps/desktop/scripts/test-windows-update-signature.mjs <public.cer> <signed.exe> <unsigned.exe>`，将三个路径替换为本地输入。它不需要 PIN 或私钥，会拒绝 PowerShell 跳过验签的情况，保持两个输入文件的哈希不变，并在 `apps/desktop/.desktop-build/qualification/windows-update-signature-*/result.json` 下写入私有报告。2026-09-11 的 `windows-update-signature-jVs7pV` 运行使用签名 `0.1.3-alpha.1` 与未签名 `0.1.5-rc.1` 安装器，四项对照均通过。这些输入不代表当前更新实现；报告仅验证签名校验，不验证其安装或发布就绪状态。

此记录不是发布认证。[强更客户端决策](../../../.agents/notes/implemented/feature/2026-09-11-desktop-mandatory-update-client.zh.md)和[本地验证决策](../../../.agents/notes/implemented/testing/2026-09-10-desktop-local-updater-qualification.zh.md)负责行为与测试限制。

常规调度集成运行位于 `apps/desktop/.desktop-build/qualification/electron-workspace-updates-oTp6fg/`，执行到正在检查／当前版本反馈，并捕获下载错误弹窗，随后达到运行器的 120 秒截止时间（`timeout=true`、`SIGTERM`）。该运行没有成功报告。刻意挂起截图的负对照 `electron-workspace-updates-3cASkr/` 中，后续诊断帧等待也在隐藏窗口中停滞；`electron-workspace-updates-PpuQrK/` 的 `windowsHide: true` 使可见性断言失败。可见窗口并发运行 `electron-workspace-updates-9JCS9h/` 记录到被遮挡的页面（`visibility: hidden`），200 毫秒动画停在时间零。它由操作截止时间触发退出码 1，而非外层总超时。原始超时缺少操作跟踪，具体停滞调用仍未知。这些失败不作为通过证据。

仓库 Host 和客户端产物已构建时，在仓库根目录执行 `node --import tsx apps/desktop/scripts/test-host-updates.ts` 可运行 Host 场景。2026-09-11 的并发运行记录在 `.desktop-build/qualification/host-updates-kJ9MJm/result.json` 和 `host-updates-m5XkWN/result.json`。每次调用在子进程退出后移除其私有链接项目，并在新建的忽略目录下保留证据。不使用安装器、云端凭据或用户 profile。

Host、客户端和 Desktop 产物已构建时，在仓库根目录执行 `node --import tsx apps/desktop/scripts/test-workspace-updates.ts` 可运行编译后主入口场景。并发报告位于 `apps/desktop/.desktop-build/qualification/electron-workspace-updates-FHCslk/` 和 `electron-workspace-updates-brIire/`，各通过十个场景、捕获十五张 PNG，且没有操作失败，包含常规轮询变更。运行器拒绝隐藏的主窗口，仅在自有观测期间临时关闭后台节流，随后恢复原设置。它不禁用动画，也不改变生产配置。每次运行在 Electron 退出后移除私有应用，不执行安装器；关联进程已退出。它复制 TypeScript 输出的 Desktop 模块及构建后的预加载，而非打包后的主入口产物或开发启动器的依赖投影。

2026-09-11 的浏览器运行设置 `PLAYWRIGHT_BROWSERS_PATH=apps/desktop/.desktop-build/playwright` 和 `DSH_SNAPSHOT=replay`，执行 `node apps/desktop/node_modules/pnpm/bin/pnpm.mjs run test:web:built apps/web/tests/desktop-updates.e2e.ts`。报告和截图位于 `.desktop-build/qualification/workspace-updates-zh-CN-p9JWom/` 和 `workspace-updates-en-US-czUF72/`。这些本地路径不提交；场景会使用新名称重新生成产物。设置／侧栏运行使用同一命令，将 Desktop 场景替换为 `apps/web/tests/settings-chrome.e2e.ts apps/web/tests/sidebar-scrollbar.e2e.ts`。

2026-09-11 解锁后的宿主证据保存在本地 `.desktop-build/qualification/` 下：`local-updater-E0dqFV/result.json` 记录 15 场景重跑；`interactive-Jds33D/interactive-result.json` 记录下载、校验、就绪及推迟安装，未调用安装器；`interactive-Jds33D/mandatory-policy-error.png` 捕获阻塞错误态。交互驱动使用真实强更页面、预加载、策略客户端、HTTP 执行器和协调器，但父窗口为空白，任务确认为模拟。标题中的 `<b>` 文本是刻意构造的纯文本安全输入，不是产品文案。验收后窗口与监听器均已关闭。这些被 Git 忽略的产物仅供检查，不是已提交或可由 CI 复现的证据。
