# @deepseek-ai/dsh-win32-process

[English](README.md) | 中文

供 Windows ACL 沙箱消费的底层 Win32 进程库。它唯一拥有仓库中可复用 restricted-process、stdio 与 Job Object 操作的 Koffi 绑定表；它不是 Cordis 服务，也不决定沙箱策略或公共 child 行为。

## Behavior

- **唯一可复用 ABI owner** — `abi.ts` 拥有 sandbox process 路径消费的 Win32 常量与 x64 布局值。`ffi.ts` 懒加载 `kernel32.dll` 与 `advapi32.dll`，核验 `STARTUPINFOW`、`STARTUPINFOEXW` 和 `PROCESS_INFORMATION`，提供带类型的操作与错误格式化，并让 sandbox policy 通过同一组已加载库绑定剩余 API。
- **restricted-token 创建** — `RestrictedProcessSpawnOptions` 要求 sandbox 的 primary token，并使用 `CreateProcessAsUserW`。pipe 与 inherited-stdio 路径共用命令行引用、cwd、继承环境块、返回值检查与句柄清理。
- **管道进程原语** — `spawnPipedProcess()` 创建匿名 stdin/stdout/stderr 管道，立即关闭 stdin，并返回两个读取端；调用方负责等待进程与排空管道。任一局部失败都会关闭该操作已经拥有的句柄，并在各自 Win32 生命周期结束后释放每个 Koffi 输出槽与结构体分配。
- **继承 stdio 的 Job 原语** — `spawnInheritedJobProcess()` 创建一个 kill-on-close Job，临时把当前 stdio 句柄设为可继承，并在创建 restricted child 时通过 `STARTUPINFOEXW` 附加该 Job。child 会在任何用户代码运行前归属 Job；attribute 设置或创建失败都会关闭全部已拥有资源，成功创建进程后不会留下无 owner 的 child。
- **显式结算归属** — `waitForProcessExit()` 等待并关闭进程句柄；`drainPipe()` 在排空期间复用一组固定原生输出槽，并在关闭管道读取句柄前释放这些槽；`closeHandleChecked()` 关闭调用方拥有的 Job 或其他句柄，并报告带操作标签的 Win32 错误。sandbox 决定这些操作何时组成公共 child 的结算与 dispose。

Windows ACL 沙箱在这些原语上增加 SID、DACL、grant、workspace 与公共 child policy。

## Model Experience

### 进程原语

#### 模型看到什么

没有直接内容。本包向 sandbox 提供 `Win32ProcessBindings` 与进程原语；sandbox 拥有全部模型可见工具、输出与诊断，本包不贡献提示词或工具 schema。

#### Token 影响

没有直接影响。消费方决定进程输出是否进入工具结果或后续模型请求。

#### KV Cache 影响

本包不贡献稳定请求前缀，因此不会使模型 KV Cache 失效。

## Known Limitations and Deferred Work

- **仅在 Windows 原生加载** — 导入通用类型可跨平台进行，但解析绑定表会加载 Windows DLL，并在其他宿主失败。跨平台测试注入绑定表，不加载原生 API。
- **没有公共进程服务** — 本包刻意不把原语包装成 Cordis 或 Node streams。消费方必须拥有自己的策略、异步调度、输出上限、取消与最终句柄关闭。
- **只继承环境** — 进程创建传入空环境块。sandbox 会先通过 `SetEnvironmentVariableW` 建立改动，因为经 Koffi 传入显式环境块会使 `CreateProcessAsUserW` 以 `ERROR_INVALID_PARAMETER` 失败。其他需要改写环境的调用方必须在调用原语前建立环境，或使用自己的 runner 进程。
- **只有 restricted-token 消费方** — ordinary `CreateProcessW`、精确 `applicationName`、parent-stdio release 与 whole-Job settlement 在 ordinary process 消费方出现前均不提供。
- **header 证据限定架构** — 已提交的 ABI probe 与布局常量覆盖仓库当前 64 位 Windows 目标。支持新的指针宽度或不兼容 Windows ABI 前，必须先更新 probe。
