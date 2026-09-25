# Agent Note: Schedule 作为按需开启的可选 bundle

Status: implemented

[English](2026-09-24-schedule-opt-in-optional-bundle.md) | 中文

## Problem

发布的 Web 组合挂载了 `time-context`、`schedule` 与 `ui-schedule`，因此每个 Web 会话都会带上四个 Schedule 工具 schema，并在每个符合条件的步骤追加一条持久时钟消息，无论该部署是否需要提醒，而且产品界面上没有这项能力的开关。

## Decision

`packages/bundle/web-app/cordis.patch.yml` 不含 `time-context`、`schedule` 与 `ui-schedule` 中的任何一行，因此随发行版交付的 Web 组合不挂载其中任何一行。

`@deepseek-ai/dsh-experimental-schedule-bundle`（`packages/experimental/schedule-bundle/`）在其 `cordis.patch.yml` 中插入这三行并依赖它们的包，与其他可选 bundle 插入各自随附的行相同。`packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES` 列出该包，`apps/cli` 将其声明为运行时依赖，因此每次安装都随包携带且默认关闭。[实验性能力作为可选 bundle 的决策](2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)负责 `OPTIONAL_BUNDLES` 的约定，以及 Web 插件管理页在 Official 分组中渲染的本地化 `icon` 与 `meta.title` / `meta.description` 元数据。

该 bundle 的清单设置 `dsh.bundle.rowSwitches: false`。插件管理器的 `listBundles` 将其报告为 `rowSwitches`，插件管理页随之列出这三行及其状态，不为单行提供开关：这些 Host 行与客户端行只能一起工作，因此 bundle 自身的开关是它们唯一的控制项。未设该字段的 bundle 仍为每行提供开关。

启用该 bundle 会插入 `time-context`（每个步骤的时钟读数，包含采样瞬时、附加到当前开放请求的浏览器时区，以及自前一条模型可见消息以来的经过时长）、`schedule`（持久提醒，以及每个活跃根 Agent 上的 `schedule_create`、`schedule_list`、`schedule_update` 与 `schedule_delete`）与 `ui-schedule`（Session 提醒目录与自动化任务页面）。持久记录、投递与管理操作由 [Schedule 子系统](../../../../docs/subsystems/schedule.zh.md)负责；该 bundle 向其加入这些行的组合由 [Web bundle](../../../../packages/bundle/web-app/README.zh.md) 负责。禁用该 bundle 会恢复随发行版交付的组合，`schedule` 行不存在期间 Host 不再调度；已存储的任务记录保留在 Schedule domain 中。

## Alternatives considered

**默认发布 Schedule。** 那样每个 Web 会话都要在每个请求头中带上四个工具 schema，并在每个符合条件的步骤追加一条持久 user 消息，从不创建提醒的对话也要承担这两项成本。这种安排还让该能力在产品界面上没有关闭开关。

**把这三行以 `disabled: true` 留在 Web 组合中，用按 id 定位的 patch 打开。** 选中该 bundle 不会再次插入某行，但插件管理器只列出 bundle 插入的行，因此该 bundle 的页面显示不含任何组件，需要为被覆盖的行另建一条列出路径；而其他可选 bundle 都插入各自的行。自行插入了其中某行的 profile，只要选中任何插入同一行的 bundle 都会把它挂载两次，覆盖式写法只为这一个 bundle 排除了这种情况。

**像其他 bundle 一样为每行提供开关。** 关掉 `schedule` 而 `ui-schedule` 仍开着，任务页面就没有服务；关掉 `time-context`，模型就无法给提醒定时；这三行是同一项能力。

**让 Official 分组中的所有可选 bundle 都不提供单行开关。** 这会连同其他可选 bundle 的单行控制一起去掉；清单字段把这项选择留给每个 bundle 的作者。

## Consequences

- 默认的 `dsh web` 会话不带 Schedule 工具 schema、Session 提醒目录、自动化任务页面与逐步时钟读数。需要它们的安装可从插件管理页启用该可选 bundle，或把该包列进 profile 的 `dsh.profile.bundles`。
- 启用后的安装会给每个活跃根 Agent 增加四个工具 schema，并在每个符合条件的步骤追加一条持久时钟消息；该读数对模型可见且持久，因此它与其他 user 消息一样参与回放、压缩，并出现在导出的 Session 日志中。
- 插件管理页在该 bundle 下列出这三行，显示各自包的 `locale/*.json` 声明的标题及其状态，不带单行开关。
- 自行插入了这三行之一的 profile 在选中该 bundle 后会把该插件挂载两次，因为 profile 补丁追加插入的行时不按 id 合并。
- 该开关只涉及配置：`src/index.ts` 是空模块，运行时内容由 patch 承载，包本身不拥有可变的运行时状态，因此不发布不变量伴随模块。
