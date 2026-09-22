---
description: "设置中的账号页面显示 DeepSeek 登录状态，并提供浏览器登录和取消；侧边栏账号菜单提供 Platform 退出登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account

[English](README.md) | 中文

账号凭据被服务端判定失效后，显示本地化的重新登录提示 toast，并清空显示的账号详情。

## 概述

设置中的账号页面显示 DeepSeek 登录状态，并提供浏览器登录和取消；侧边栏账号菜单提供 Platform 退出登录。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

侧边栏和账号设置以圆形图片显示账号头像；头像 URL 缺失或图片加载失败时使用账号图标兜底。折叠侧边栏将头像居中放置在 36 × 36 px 的按钮内。

该页面通过 settings.section 注册，并使用 account Remote 命名空间。共享 Remote 管理器负责连接恢复后的流重连。页面使用功能自有的中英文文案，将 API Key 与账号状态分开。

余额沿用 Platform Web 的金额格式：两位小数和千分位分组，正金额截断至分，小于一分的正金额显示为 <0.01，负金额按舍入规则处理且显示绝对值至少为 0.01。Host 返回的原始余额字符串保持不变。

Desktop 的用量和充值操作在 48px 返回栏下方打开隔离的原生 Platform 视图。返回操作销毁视图并保留 Account 设置页。浏览器客户端继续使用外链。加载失败时保留返回操作并显示现有本地化兜底提示；渲染进程命令不接收账号 token。

“联系我们”在 Desktop 的系统浏览器或 Web 的新标签页打开飞书问卷。链接通过 prefill_* 参数填写已有的 Platform UID、构建版本、界面语言和屏幕物理分辨率，并为所有上下文字段设置 hide_*=1；不传 token 或联系方式。可在 ui-settings-account 插件配置 contactFormUrl，切换到另一个 HTTPS 问卷。问卷支持 Harness 来源选项前，contactSource 默认为空；OS 和设备字段沿用 Web 实现，保持未填写。

侧边栏账号菜单使用公共 Menu 的表面、背景模糊、间距和菜单项排版；功能样式仅设置入口布局。

账号卡片的“更多账号信息”链接在 Desktop 中通过系统浏览器打开 `https://platform.deepseek.com`，在 Web 中打开新标签页。

退出登录先查询正在使用账号 token 的任务，再打开确认弹窗。有此类任务时提示执行将被打断，否则提示数据保留且可重新登录。取消、关闭和 Escape 均不退登。影响查询失败仍打开确认弹窗，并明确提示无法确认任务状态；退登失败保留弹窗以便重试。

<a id="understand-the-implementation"></a>
## 理解实现

仅登录后在设置导航首位显示账号页；账号状态加载完成前以及退出登录后隐藏该页。 插件持有一条 Host 快照流，通过框架 hook 供 settings.section 和 settings.launcher 共享。入口菜单可打开设置，并仅在已存储账号凭证时提供退出登录。Platform 请求失败时保留菜单，以供重试。插件不维护独立凭证状态，因此不发布 invariant。

<a id="further-exploration"></a>
## 深入探索

[凭证子系统](../../../docs/subsystems/credentials.zh.md)定义存储接口；[架构](../../../docs/architecture.zh.md)说明应用组合。

账号登录在模型引导的凭证编辑器之前显示可关闭的弹窗。弹窗底部采用紧凑的右对齐横排操作，主操作位于末尾。侧边栏优先显示昵称，缺少昵称时显示服务端返回的脱敏手机号或邮箱；资料加载期间保持留空。 弹窗文字和侧边栏账号状态文字不可选中，复制登录链接按钮始终可用，并在每次复制成功两秒后恢复原文案。剪贴板失败时，链接原位显示“复制失败”两秒，不中断登录。等待状态提供可复制的授权链接和加载图标；超时和失败均须用户手动重试。关闭等待弹窗会取消对应 Host 登录流程。侧边栏通过设置协调器重新打开同一个 API Key 编辑器。浏览器登录在点击时预先打开标签页，只有该次流程收到授权地址后才导航；弹窗被拦截时保留复制链接入口。原标签页保留授权窗口引用，并在失败、超时或取消时关闭它。登录反馈留在原标签页，回调不会导航到第二个 Web UI。

余额卡片分行展示充值余额与正额赠金余额。赠送钱包为空或没有正余额时，隐藏赠金行及其分隔线；不同币种分别显示。


首次成功登录且用户尚未保存模型选择时，从 `deepseek-account` 初始化默认模型。后续登录保留已保存的选择，包括不可用的选择。

<a id="model-experience"></a>
## 模型体验

无，因为账号凭证只影响 HTTP 认证，不进入模型提示、Session 日志或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 资料和充值钱包余额通过 Host getProfile / getBalance 复用已有 Platform Web 接口。页面在打开、登录及重连后刷新，原样显示服务端脱敏后的联系方式，并分别处理查询失败，不将失败显示为零余额。用量和充值使用 Host 按 platformOrigin 派生的链接，并沿用浏览器自身登录态，不携带 DSH token。

<a id="dev-note"></a>
### 开发备注

[桌面登录决策](../../../.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.zh.md)记录取消和存储的职责。

用量和充值在原生页面加载完成前显示居中的 24px 加载图标，不显示加载文字；返回操作始终可用。加载 SVG 从 Figma 节点 2957:72553 内嵌到本地样式。

默认模型初始化在登录帧发布并确认接收后运行，不延迟后续账号帧。初始化失败会记录诊断日志，不会将已登录账号标记为失败。
