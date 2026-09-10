# Agent Note: 原生 Windows 安装页面

Status: implemented

[English](2026-09-10-windows-native-installer-pages.md) | 中文

## Problem

Windows 安装界面需要符合品牌设计的亮暗页面，同时避免引入额外的应用运行时，也不能替换 Desktop 的解压、注册、升级和卸载发布机制。

## Decision

安装程序通过 electron-builder 的 NSIS include 接入自定义欢迎页、进度页和完成页。原生脚本继续负责安装和卸载程序生成。完整自定义脚本会绕过 electron-builder 单独生成并签名卸载程序的流程，因此不适合这次界面改动。[Desktop 发布决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)继续负责发布身份、更新分发和签名要求。

NSIS 原生控件保留目录编辑、文件夹选择、复选状态和键盘交互。x86 Win32/GDI+ 辅助库保留 DWM 阴影，并在原生安装工作线程运行期间，由界面线程绘制安装进度。即使 NSIS 在 MUI 回调之后重新显示页面，原生页面仍保持隐藏。Windows 11 提供外框圆角半径；Windows 10 保留其支持的窗口外观。

安装面向当前用户。安装写入前校验路径；应用运行中时保持应用运行，安装程序在用户确认系统提示后退出。完成时仅在勾选启动的情况下启动应用。静默更新保留现有 electron-builder 命令行行为。安装引擎不新增事务回滚，也不接管首次启动的配置档案准备。

## Alternatives considered

**Electron 安装界面**会在应用安装前引入运行时，并要求额外的安装通信机制。原生控件能在现有安装程序内提供所需交互。

**使用轻量原型替换完整 NSIS 脚本**还会替换升级、注册表、卸载和签名行为。原型的事务机制需要单独进行发布验证，不纳入界面接入。

**使用窗口区域裁剪圆角**会禁用 DWM 窗口阴影。系统窗口框架保留阴影，同时接受平台提供的圆角半径。

## Consequences

Windows 打包额外要求 x86 Visual C++ 编译器和 Windows SDK。辅助库使用与其他 Windows 产物相同的签名器。进度来自原生 NSIS 进度估算，不承诺剩余时间。

原生安装回归使用独立产品身份和私有安装目录，验证路径拒绝、文件夹选择、启动选项、升级、运行中进程保留、原生进度条隐藏和卸载。截图和预期行为归属 Desktop 测试，不放入录制 Session 快照。签名发布仍需使用已配置的证书、Token 和真实 Windows 更新产物进行验证。
