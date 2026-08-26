# Agent Note：只读 Web Schedule 目录

Status: implemented

[English](2026-08-25-read-only-web-schedule-catalog.md) | 中文

## 问题

Schedule 已经持久化活动提醒，并把到期工作作为普通后续对话轮次交付，但 Web 用户无法查看仍有哪些提醒处于活动状态。面向模型的 `schedule_list` 工具不适合作为浏览器契约：调用它会增加一次工具事务、把 UI 耦合到 Agent 可用性，并重复 Session projection transport 已经提供的持久读模型通道。

该目录还必须保留两条既有边界。fork 的事件数组虽然包含继承前缀，却不能继承父 Session 的活动提醒；活动提醒列表也不能在普通 Assistant 回答之外变成第二种交付回执。

## 决策

Schedule 注册一个可选的 `schedule` Session projection，由独立浏览器包渲染这份完整活动值。持久 `schedule/change` stream 仍是唯一权威；浏览器只做呈现派生，不公开 mutation。

### Projection 边界

Schedule 单元复用领域的严格 transition，并发布完整的活动 `ScheduleRecord[]`；损坏的权威输入会使既有读取／打开路径失败，生产 prepared-session 路径可以从日志重建畸形的可丢弃 checkpoint。共享的 [projection state 与 Client views 决策](../architecture/2026-08-19-session-projection-state-and-client-views.zh.md)拥有 `init(header)`、集中 seed 边界校验、checkpoint 校验，以及 live／cache／history／detached 驱动路径。本 Note 只拥有所得活动值在 Web 中的呈现方式。

`@deepseek-ai/dsh-schedule/client` 是持久记录词汇的纯类型浏览器安全出口。它不会把 Cordis 插件、runtime、timer、工具或 Node 依赖带入 client graph。

### Web 组合与可见性

shipped Web bundle 拥有 `@deepseek-ai/dsh-client-ui-schedule` 的解析依赖，以及一个带 `disabled: true` 的 `ui-schedule` row。现有 Schedule overlay 加载 `time-context` 与 Schedule Host 插件，再按 id 启用该 row。普通 Web 因而只解析但绝不启动该插件；只有显式 Schedule 组合同时获得 Host 与 client 两半。

header action 通过标准 Session hook 读取 `openState`，通过 `useProjection` 读取 `schedule` projection。只有 `openState === 'open'` 且数组非空时才渲染。这条门槛也会在当前 Session 打开失败时隐藏曾由列表缓存预热的值。live 更新移除最后一条记录时，控件会关闭并卸载。

slot 条目使用内部 order 10：静态 Agent 与 Subagent 信息位于它之前，order 20 的 Jobs 入口位于它之后。组件不拥有共享 store；popover 是否打开是唯一的本地交互状态。

### 侧边栏标识

`ui-workspace` 拥有普通、平铺与搜索 Session 行。它从 `SessionSummary.projectionValues.schedule` 派生一个展示事实：非空数组会在标题之后渲染同一枚轮廓闹钟，普通行的更新时间仍位于其后。图标不单独响应点击或进入 Tab 顺序；本地化 tooltip 与读屏标签说明该 Session 有活动定时任务。

cold 行有意继承 projection-cache 语义。身份匹配且可用的缓存值可以在不打开 Session 的情况下显示闹钟；cache 缺失或陈旧可能造成短暂漏显或残留。该标识只报告列表值已知存在尚未 dispatch 或 delete 的持久记录，绝不表示 Schedule runtime 当前 live 或能够唤醒该 Session。

### 呈现与交互

336px 弹层为每条活动记录渲染一行不可聚焦内容。prompt 是可完整换行、没有 line clamp 的纯文本；内容超过既有最大高度时，列表在内部纵向滚动。行中不包含 Schedule id、原始 UTC、详情或操作控件。

每行把状态与三项元数据分开呈现。After 与 At 本地化为「单次」。Every 选择能够整除持久 `everySeconds` 值的最大日、小时、分钟或秒单位，因此 300 秒显示为 5 分钟，301 秒仍显示为 301 秒。浏览器用当前 locale 与时区格式化 `scheduledAt`，并按当前时钟派生相对时间。这些值都不会写回 projection。

行先按 overdue 排序，再按 `scheduledAt` 升序，最后按 projection 数组索引排序。最终 tie-break 保留 Schedule fold 的创建顺序，不增加持久排序字段。scheduled 状态使用业务蓝语义圆点；overdue 使用警告琥珀语义圆点与行背景。

触发器是目录唯一的 Tab stop。原生 button 行为提供 Enter 与 Space 激活。Escape 会关闭已打开的弹层并把焦点还给触发器；在外部按下指针也会关闭。projection 更新移除最后一行时，组件不会调用 focus，也不会把焦点迁移到相邻 header action。

### 交付边界

该目录表示当前活动状态，不是历史或交付证明。终结性的 delete 或 dispatch 会移除一行。到期工作仍只通过普通 Schedule `followup()` 与 Assistant 结果进入 transcript。目录不发出消息、卡片、Toast、acknowledgement、Retry 控件或 Schedule 专属错误入口。

## 已考虑的替代方案

**从浏览器调用 `schedule_list`。** 这会跨越面向模型的工具边界，需要 live Agent，并为 projection carrier 已经拥有的数据制造请求与旧响应处理机制。

**渲染原始 `schedule/change` 事件。** 事件是持久化协议，不是呈现协议。客户端 fold 会重复严格领域逻辑，并暴露内部 id 与 transition。

**持久化状态、相对时间或显示顺序。** 这些值取决于查看方浏览器的时钟、locale 与时区。持久化它们会使回放依赖环境，并增加不必要的持久字段。

**在 Session 打开失败时仍显示控件。** 缓存的列表值可能旧于损坏的 tail。显示它会在严格回放已经拒绝权威 Session 时呈现貌似可信的部分事实。

**增加行操作或回执历史。** mutation 属于既有工具，交付历史属于普通 transcript。把任一项并入该目录都会改变它的权威与可访问性模型。

## 验证

聚焦 projection 与 Schedule 测试覆盖严格 fold、fork 前缀排除、restore、损坏传播与注册生命周期。`ui-schedule` 测试覆盖 header 目录的 open-state 门槛、本地化格式、由时钟驱动的状态与排序、换行与滚动、移除、pointer／键盘行为及焦点边界。`ui-workspace` 测试覆盖分组、平铺与搜索标识的派生、位置、本地化、无障碍与整行点击行为。一个无密钥 shipped-Web smoke 覆盖默认 disabled 与 overlay enabled 组合、普通行与搜索结果中的缓存标识、当前 Session 的 900px 暗色目录，以及一次 live empty 更新同时移除 header 与侧边栏标识；既有对话场景继续覆盖普通 Assistant 交付。

## 后果

- 用户可以查看每条活动提醒，而无需调用模型或增加另一份持久权威。
- fork 隔离属于共享 projection 初始化约定，而不是 Schedule 专属的带外扫描。
- 侧边栏闹钟始终是尽力而为、由 cache 支撑的列表呈现，绝不会变成 runtime 存活标识。
- 不同查看者的浏览器时间标签可能因 locale、时区与时钟而不同，持久记录仍完全相同。
- 损坏的 Schedule history 会使正常 Session 路径失败，绝不会降级成貌似可信的部分目录。
- 该目录不能确认、重试、编辑或证明交付；这些语义有意留在此界面之外。
