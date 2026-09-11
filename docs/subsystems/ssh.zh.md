# SSH

[English](ssh.md) | 中文

[SSH 提供方家族](../../packages/ssh/README.zh.md) 通过部署方持有的 OpenSSH 连接提供一个远端文件系统／进程环境。Harness、模型传输及 Session 存储留在主机。该家族实现既有文件系统、子进程及沙箱 API，不引入 SSH 专用模型工具。

## 执行坐标

文件系统身份、可执行文件查找、进程 cwd、沙箱工作区根目录及语言服务器文件 URL 都指向 SSH 主机。提供方在文件实际存在的位置规范化路径，保留文件系统对 `symlink/..` 的解释。策略解析器保留执行环境中的绝对路径写法，不尝试在 Harness 主机上解析远端路径。

`processPath()` 提供配套子进程提供方可用的路径。SSH 的 `processPathFromHostPath()` 仍不可用；安装远端产物不意味着任意主机路径可移植。因此 [`NodeCodeRuntime`](../../packages/code-runtime/code-runtime-node/README.zh.md) 使用显式安装并经过摘要验证的远端引导程序。

## 传输与信任

管理 RPC 使用辅助进程的 SSH exec 流。普通 stdin、stdout、stderr、终端输出及可选 fd 7 控制流使用分别认证的转发 Unix 套接字。每条转发流拥有独立 SSH 通道窗口；暂停的程序输出不与控制或管理消息共用窗口。所有通道仍共享连接带宽及传输失败。

部署认证、已安装产物验证及逐流 TLS 认证属于 [`dsh-ssh`](../../packages/ssh/ssh/README.zh.md)。辅助进程使用远端机器上的可信本地提供方执行文件系统与进程请求。SSH 是传输方式；文件效果限制由所选远端沙箱提供方执行。

## 进程生命周期与取消

进程先预留，再连接流，且启动最多接受一次。`done` 报告直接结果，`waitForExit` 观察远端托管进程范围。终端操作保留共享异步 API。准备阶段取消、已启动进程终止及提供方释放都通过辅助进程释放各自资源。

管理截止时限约束单次 RPC 观察，不替代 Bash 或代码运行时消费方选择的执行截止时限。远端等待可以持续挂起，同时其他请求继续推进。SSH 丢失会使待处理操作失效；辅助进程 EOF、信号及租期到期会启动远端清理。客户端如实报告未确认结果，绝不通过重连重放可能已执行的操作。

## 组合范围

headless 通过已挂载的文件系统提供方记录和检查 Session cwd。因此远端 FS、Bash、终端、LSP 及 PTC 消费方可以共享这些坐标。假定可访问主机文件系统的 Web 工作区视图需要单独集成；仅替换提供方并不会使这些视图支持远端。

替代方案与验证责任见[决策记录](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md)。
