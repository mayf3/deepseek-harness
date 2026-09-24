---
description: "配置桌面端产品埋点、身份字段和事件时机，不采集 Web 使用情况。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-product-analytics

[English](README.md) | 中文

## 概述

通过现有 OTel 产品导出器采集指定的桌面端交互。应用可以关闭采集，无需提供用户设置入口。普通 Web 客户端不会提交这些事件，缺失的登录身份字段会省略。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

桌面启动器在测试阶段默认开启产品埋点。在启动环境中设置 `DSH_PRODUCT_ANALYTICS_ENABLED=0`，下次启动时关闭；`1` 表示开启。其他值会被拒绝。该设置统一控制原生登录与升级事件、渲染进程事件和 Host 压缩事件采集。关闭后不会创建导出器、读取埋点身份或保留事件供以后补发。会话反馈遥测采用独立策略。

共享组合向本插件提供 `enabled`（默认 `false`）和可选的 `appVersion`。桌面 Host 会开启它，普通 Web Host 保持关闭。`DSH_PRODUCT_ANALYTICS_OTLP_URL` 可覆盖导出目的地，用于隔离的接收端。[导出器](../../host/product-telemetry-otel/README.zh.md)负责批量发送、重试和退出时的交付。

公共字段为 `device_id`、`user_id`、`os_version` 和 `app_version`。设备身份复用现有登录记录，不会生成新标识。Host 只从账户会话中选择账户 ID。缺失值会省略；API key、账户令牌、提示词和模型回复都不是事件字段。

[事件类型](src/events.ts)定义名称和允许的字段。页面曝光按实际进入可见页面计数，关闭 onboarding 弹窗不产生事件。有余额时的继续按钮使用 `next`。发送时采集 `submit_source`、`submit_type`、模型、思考强度和 `run_mode`；计划模式优先于活跃目标。首次发送的空白会话省略 `session_id`。模型与插件切换仅在变更被接受后上报。分叉事件携带已创建的子会话 ID 和来源 ID，在可选的子会话标题更新前上报；创建失败不产生事件。

插件条目使用 `plugin_type=plugin`，插件包使用 `bundle`。安装通过独立于 `error_reason` 的 `result_status=success|failed|cancelled|unknown` 表达结果，并保留 `is_success`。耗时单位为毫秒，从检查输入开始，到最终结果结束，包含内部源重试。显式批准构建后的重试开启新的一次尝试。需要重启视为成功。临时断线保留待定操作；只有恢复查询确认没有结果时才成为 `unknown`。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

展示组件接收回调。共享 Client 服务读取可选的桌面埋点发送器，后者要求同时存在原生 preload 标识和 Host 采集标记。原生操作使用已认证的 Host API，其生成的 Typert 校验器只接受类型中声明的事件字段。Host 在入队前补充身份信息，并监听实时压缩事件，不重放会话历史。本包不发布运行时不变量伴随模块，因为采集没有可用于比较的独立交付确认。

</details>

<a id="model-experience"></a>
## 模型体验

无；埋点不增加模型上下文或会话事件。

#### KV 缓存影响

无；采集不修改模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

交付采用尽力而为的方式。

- 开关在启动时读取；没有用户控件或实时偏好更新。
- 渲染进程的发送失败会被丢弃，导出器没有持久化待发队列或数据仓库确认。
- 原生启动事件等待 Host 认证完成；若进程在 Host 就绪前失败，则无法上报启动事件。

### 开发备注

无。
