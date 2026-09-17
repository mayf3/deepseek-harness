# Agent Note: 账号提供方与当前请求取消

Status: implemented

[English](2026-09-17-account-provider-signout.md) | 中文

## Problem

根据登录态选择凭证会改变现有提供方路由的计费身份。退登也需要停止依赖账号的任务，不能根据请求或工具运行期间可能已经改变的设置判断归属。

## Decision

`deepseek-official` 和 `deepseek-account` 是独立路由，共享 DeepSeek 协议实现及已校验的连接设置。每个适配器仅有一个凭证解析器和认证请求头模式。两条路由均不回退到另一凭证。账号服务保留[登录决策](2026-09-14-deepseek-account-login.zh.md)定义的来源及签发方校验。

Agent 运行阶段拥有 `activeProvider`，其值是请求准备返回的最终提供方。该值在工具执行及重试准备期间保留，在绑定下一请求时改变，在 `turn/end` 前清除。轮次的首请求准备期间该值为 undefined。账号凭证缺失仍在首请求进入传输前拒绝请求。Token 解析检查本地退登是否进行中；不为短暂的读取 token 到发送间隙引入登录级信号、凭证租约或同步协议。

本地退登成功后发布账号事件。DeepSeek 插件遍历运行中的 Agent 注册表，通过 `Agent.cancel` 取消匹配的账号路由并保留收件箱。每个已注册子代理独立分类；生命周期绑定到已取消父代理的子代理仍受现有父级取消规则约束。独立的 API Key 代理继续运行。现有 HTTP 信号将取消传递到传输层。

## Alternatives considered

历史提供方集合会在轮次切换到 API Key 路由后仍错误取消它。当前设置会误判更早的在途请求。模块级全局映射重复拥有 Agent 生命周期，让账号服务管理所有提供方则反转服务依赖。登录级取消信号重复现有 Agent 与 HTTP 取消链路。

## Consequences

模型选择展示两条路由，即使存在 API Key，选择账号路由仍要求登录。账号路由与 API Key 路由共享模型目录和连接设置。取消保留排队输入，不自动唤醒。已记录的 hook 原因生成本地化对话提示，无须改变持久事件类型。

行为测试覆盖凭证分离、首请求准备、工具阶段取消及路由替换。SDK account-provider-signout 场景启动随附 profile，记录被中断的输出和取消原因。
