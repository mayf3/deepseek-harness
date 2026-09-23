# Agent Note: 按账号隔离的 Platform 浏览器存储

Status: implemented

[English](2026-09-22-platform-browser-storage.md) | 中文

## Problem

内嵌 Platform 通知将关闭状态写入 localStorage。一次性浏览器分区会在每次关闭视图后丢失该偏好。

## Decision

Desktop 使用 Platform 来源和稳定账号 ID 的 SHA-256 哈希划分浏览器存储。持久分区跨视图和应用生命周期保留页面偏好，包括退出登录后再次登录同一账号。分区名不包含原始账号 ID 或 token。无法取得账号 ID 时，视图使用一次性存储。

关闭视图会销毁文档并移除携带凭证的请求拦截器，同时刷新 DOM 存储并清理 Cookie、HTTP 认证和连接。重新打开会等待清理完成；清理失败时禁止打开新文档。仅限 Host 的凭证仍通过现有 preload 传入受信任页面，bridge 不会将其写入浏览器存储。

## Alternatives considered

共享分区会混用账号偏好。以 token 命名会在凭证变化时丢失偏好。专用于通知的原生 API 会重复承担 Platform 偏好管理职责，并要求前端同步修改。

## Consequences

偏好仅保存在此 Desktop 浏览器数据目录中，不跨设备同步。Platform 脚本仍须可信地处理收到的凭证；持久站点存储不是凭证保险库。账号资料查询可能延迟首次准备 Platform 会话。真实 Electron 回归测试验证视图重建、账号切换和进程重启后的通知关闭状态。
