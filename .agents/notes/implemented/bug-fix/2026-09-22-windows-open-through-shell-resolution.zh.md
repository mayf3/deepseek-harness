# Agent Note: Windows 打开走 shell 自身的默认应用解析

Status: implemented

[English](2026-09-22-windows-open-through-shell-resolution.md) | 中文

## 问题

Windows 桌面客户端设置页的「打开配置文件」会准备当前 profile 的 `cordis.patch.yml`，并把该路径交给原生文本编辑器打开器（issue #4428）。在报告者机器上，这个动作既没有打开窗口，也没有任何提示。打开器执行的是 `powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath '<path>'"`，因此由宿主进程内的关联解析决定结果，而 `Invoke-Item` 在解析不到应用时同样以退出码 0 结束。

该机器的 `.yml` 默认值只记录在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.yml\UserChoiceLatest`（progid 为 `VSCode.yml`），既没有 `UserChoice` 记录，也没有 `HKCU\Software\Classes\.yml` 默认值。对同一个文件双击，资源管理器会打开 VS Code。而在宿主进程中执行时，`Invoke-Item`、`cmd /c start`、`Shell.Application` 的默认动词和 `AssocQueryString` 都报告该扩展名没有应用，`cmd /c start` 则弹出 shell 自己的应用选择框而不是打开某个应用。`Invoke-Item` 仍然返回 0，于是 `SettingsController.openSettingsDocument` 回答 `{ opened: true }`，设置页不渲染任何错误。

## 决策

`openWindowsPath` 将路径作为**一个** argv 元素交给 `explorer.exe`，`revealNativePath` 经共享的 `runExplorer` 帮助函数走到同一个 shell。资源管理器执行的是双击所执行的默认应用解析，因此由 shell 的答案选择应用——包括只记录在较新的按用户记录里的默认值；而完全没有处理程序的机器会得到资源管理器自己的「你要如何打开这个文件?」选择框，而不是毫无反应。

`runExplorer` 为两种操作持有唯一一条 Explorer 调用规则：退出码 1 是 Explorer 把请求转交给已在运行的桌面进程后返回的交接码，它照常兑现调用方的 Promise；其余失败和取消仍然报错。该帮助函数取代了 PowerShell 命令字符串，同时删掉了 `powershellLiteral` 及其单引号翻倍逻辑：路径现在以 argv 元素跨进程边界，不存在可能写错的转义步骤。

Windows 对 HTML 与 SVG 仍然无法命名浏览器，因此 `openInBrowser` 继续拒绝该平台，默认意图、关联意图与文本编辑器意图都走同一个 Explorer 交接。

## 考虑过的替代方案

**继续使用 `Invoke-Item`。** 已否决。它询问的解析器与 shell 不同，因此即使某个用户的默认值能被资源管理器识别，仍会得到静默的无效操作；而且它的零退出码正好抹掉了设置页本应渲染的错误。

**在宿主进程内自行解析默认值。** 已否决。依次读取 `UserChoiceLatest`、`UserChoice` 和 classes 默认值，再启动胜出 progid 的 `shell\open\command`，等于重新实现一套 Windows 自己拥有的顺序，其中还包括 Windows 会校验的 `UserChoice` 哈希；而双击所用应用的定义就是 shell 自己的答案。

**使用 `cmd /c start <path>`。** 已否决。它为资源管理器本已执行的同一套解析引入一个命令 shell，并且在复现该缺陷的机器上同样报告没有应用。

**解析不到应用时回退到固定编辑器。** 已否决。Windows 安装总是带有可用的编辑器，但在打开器里选择它等于覆盖用户的关联，并把「缺少关联」变成「静默地打开错误应用」。

## 后果

设置页的打开动作与产物、工作区的打开动作共享同一个 Windows 行为：双击会启动的那个应用。对于「资源管理器认、`AssocQueryString` 不认」这一被报告的状态，现在会打开已配置的编辑器。

打开器再也无法区分「shell 打开了」与「shell 拒绝了」：两种情况 Explorer 都返回 0 或 1，因此 Remote 依旧回答 `{ opened: true }`，完全没有处理程序的机器只能看到 shell 的选择框。此处不校验窗口是否真的出现。

目录走同一条路径。[open-in-app 记录](../feature/2026-08-25-promote-open-anywhere-plugin.zh.md)中被否决的方案是 detached 且经过凭据清洗的 `explorer.exe <dir>` 派生进程，那不是本交接的做法：运行器继承宿主环境，也不创建 detached 进程。

## 验证

`path-opener.spec.ts` 固定两种意图交给 Explorer 的 argv、打开与选中都可接受的交接退出码 1、仍然报错的普通失败与取消，以及不存在任何转义步骤。`resolver.spec.ts` 固定 open-in-app 路由在 Windows 上的命令。按该包测试策略，原生桌面验证留在 Windows；在 Windows 11 build 26340 上已观察到文件与目录打开分别启动了关联应用和文件夹窗口。
