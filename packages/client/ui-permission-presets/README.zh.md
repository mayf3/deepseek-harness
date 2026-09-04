---
description: "Web GUI 的权限预设表面：通用设置中的默认行与切换当前会话的 /permission 选择器；供权限策略的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-permission-presets

[English](README.md) | 中文

## 概述

本包为 Web GUI 中两种生命周期提供权限预设表面：通用设置中的一行选择之后创建会话所用的默认值，但不会切换当前会话；挂在宿主 `/permission` 命令上的选择器则通过一张扁平的实时预设列表切换当前会话，并标记 active 值。规范内置名称渲染为 locale 所有的产品标签，显式 host 标签保持原样，未知 kebab-case 名称渲染为 Title Case，仅限当前会话的 `auto` contribution 显示为带 `EXP` badge 的 `Auto review`。通过任一表面选择完全权限，或通过可见选择器选择 Auto review 时，都必须分别显式确认对应风险；已经带参数的 `/permission <preset>` 命令仍直接执行。两个表面通过宿主命令或设置 owner 写入。进程级 `permissionPresets` 目录拥有可选项，而当前会话投影只拥有 picker 与 composer chip 使用的 active 值。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与设置与命令包一起挂载本插件；权限行随即出现在通用设置中，`/permission` 选择器替换裸命令调用。当前会话选择器恰在投影 key 存在时可用；无权限组合既不显示选择器，也不显示设置行。

### 选择器

选中即提交 `/permission <preset>` 命令行。带参路径（直接键入 `/permission <preset>`）仍直接切换；装饰只替换裸调用。内置标签在英文界面中是 `Read Only`、`Workspace Write`、`Full access` 和 `Auto review`，在中文界面中是「仅可查看」「工作区内修改」「完全权限」和 `Auto review`。显式 host 标签保持原样，未知 kebab-case 名称渲染为 Title Case；`auto` 带有 `EXP` badge，并在可见选择时要求实验风险确认。`custom` 只是显示状态，绝非目标。

### 设置行

该行从宿主动态的 `defaultPreset` enum 推导选项，使用与当前会话选择器相同的本地化内置标签，并写入一条设置变更操作。`auto` 等仅限当前会话的 contribution 不会出现。该值只在之后创建会话时生效；改变它绝不会切换或改写当前会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

General Settings 行经 `ctx.settingsScope` 读取显式暴露的 `permission` Settings 描述符，并携带描述符 revision 写入一条 `settings.mutate` 路径操作；其 observable 经 slot 系统的 `hooks` compartment 传递，因此 React 钩子绑定归渲染器，推送失效通知会重新获取描述符。该值只在之后创建会话时读取。当前会话表面是挂在宿主 `/permission` 命令上的 popupSelect 装饰（`ctx.commandUi.decorate`）：宿主命令保留斜杠菜单行、带参路径与持久生命周期记账，装饰只把裸调用替换为选择器。一个进程级目录会在首次 Remote 读取前订阅无 payload 的目录通知，并且只发布当前连接代际中最新的完整成功结果。胜出的读取失败或连接 reset 会清空旧快照，使选择器在后续既有触发重试前处于本地不可用状态；旧连接代际与 dispose 后才返回的结果会被忽略。它的公共状态只有 `{ value }`，失败仅供命令式加载内部使用。slash popup 与 composer seat 共用这份目录，而 Session `permissions` 投影只提供 `currentValue`。Full access 与 Auto review 各自携带本地化确认文案；Auto 还携带由共享 popup 外壳渲染的 badge。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当权限面不够用时阅读以下页面。它们从浏览器表面进入宿主策略与命令外壳。

- [dsh-permission-presets](../../interaction/permission-presets/README.zh.md)——这些表面写入的宿主侧权限预设策略。
- [ui-commands](../ui-commands/README.zh.md)——`/permission` 装饰注册进的 popupSelect 外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——把这份共享目录与 Session 当前值合并的 composer seat。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接影响。它的两个表面写入权限事实：设置行使未来会话带着全量值旋钮事件启动，而 `/permission` 选择器追加选中的当前会话预设。沙箱与审批消费方各自解析自己的旋钮事件；选择 `auto` 还会启用宿主 Auto integration 的独立逐调用 reviewer。

#### KV Cache 影响

无直接失效；请求前缀的变化由旋钮消费方自行承担。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前权限表面。它们是当前包约束，不是通用策略对比或任务积压。

- **设置行仅限 Web**——非 Web 客户端仍可经 `/permission` 切换当前会话，但不会获得这项浏览器贡献。
- **Auto review 仅限当前会话**——General Settings 行有意省略它，且只有通过可见选择器选择时才显示实验确认；显式键入 `/permission auto` 已经构成明确同意。
- **预设描述来自宿主**——本地化的内置标签旁边可能显示另一种语言编写的描述。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。command 与 slot contribution 的生命周期由 HMR 测试覆盖；浏览器侧 Settings controller 不持有 Host 事件或跨插件可变状态。
