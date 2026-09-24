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

桌面启动器默认开启产品埋点。在启动环境中设置 `DSH_PRODUCT_ANALYTICS_ENABLED=0`，下次启动时关闭；`1` 表示开启。其他值会被拒绝。该设置统一控制原生登录与升级事件、渲染进程事件和 Host 压缩事件采集。关闭后不会创建导出器、读取埋点身份或保留事件供以后补发。会话反馈遥测采用独立策略。

共享组合向本插件提供 `enabled`（默认 `false`）和可选的 `appVersion`。桌面 Host 会开启它，普通 Web Host 保持关闭。`DSH_PRODUCT_ANALYTICS_OTLP_URL` 可覆盖导出目的地，用于隔离的接收端。[导出器](../../host/product-telemetry-otel/README.zh.md)负责批量发送、重试和退出时的交付。

公共字段为 `device_id`、`user_id`、`os_version` 和 `app_version`。设备身份复用现有登录记录，不会生成新标识。Host 通过 `deepseekAccount.getDeviceIdentity()` 读取不含凭据的设备、账户和操作系统字段。缺失值会省略；API key、账户令牌、提示词和模型回复都不是事件字段。

桌面 Host 从经过校验的启动开关派生内部变量 `DSH_DESKTOP_PRODUCT_ANALYTICS=0|1`。Electron 通过内部变量 `DSH_PRODUCT_ANALYTICS_APP_VERSION` 传递运行版本；启用导出器时该值必填。这些变量属于桌面启动器与 Host 之间的协议，不是 Web 开启采集的控件。桌面导出、批次与关闭期限分别为 1000、1500 和 2000 毫秒，均短于 Host 退出预算。启用采集但未挂载导出器时会记录配置警告。

[事件类型](src/events.ts)定义名称和允许的字段。页面曝光按实际进入可见页面计数，包括重新显示的原生欢迎窗口；onboarding 短暂进入加载状态不会重复计算同一页面曝光，关闭 onboarding 弹窗不产生事件。有余额时的继续按钮使用 `next`。消息提交在异步命令裁决前采集 `submit_source`、`submit_type`、模型、显式思考强度和 `run_mode`；仅默认消息发送路径上报，已处理的命令不计入。程序化提交省略 `submit_source`；键盘与按钮操作分别使用 `enter` 和 `click`。计划模式优先于活跃目标。采集和上报异常不会中断提交。首次发送的空白会话省略 `session_id`。模型与插件切换仅在变更被接受后上报。分叉事件携带已创建的子会话 ID 和来源 ID，在可选的子会话标题更新前上报；创建失败不产生事件。

插件条目使用 `plugin_type=plugin`，插件包使用 `bundle`。安装通过独立于 `error_reason` 的 `result_status=success|failed|cancelled|unknown` 表达结果，并保留 `is_success`。耗时单位为毫秒，从点击安装开始，到最终结果结束，包含校验、检查输入和内部源重试。`input_value` 仅保留 registry 包标识和普通版本；Git 输入记为 `[git]`，其他 URL 记为 `[url]`，路径及无法识别的输入记为 `[path-or-other]`。点击和结果均使用脱敏后的值。重新打开已隐藏的安装弹窗会再次计为 `plugin_add_button_click`。`is_builtin` 表示由安装供应（`installed=false`），不表示 profile 是否显式依赖该包。显式批准构建后的重试开启新的一次尝试。需要重启视为成功。临时断线保留待定操作；只有恢复查询确认没有结果时才成为 `unknown`。

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
