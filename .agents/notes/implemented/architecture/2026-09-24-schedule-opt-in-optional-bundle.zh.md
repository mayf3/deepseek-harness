# Agent Note: Schedule 作为按需开启的可选 bundle

Status: implemented

[English](2026-09-24-schedule-opt-in-optional-bundle.md) | 中文

> 取代[默认 Web 组合中的 Schedule](../../archived/architecture/2026-09-24-web-default-schedule-composition.md)：Web 组合现在不携带任何 Schedule 行，此 bundle 只插入它自己随附的 `schedule` 与 `ui-schedule` 两行。

## Problem

Host 的 Schedule 服务及其客户端界面会给 `standard`、`cordis` 与 `ptc` preset 的活跃根 Agent 增加四个工具 schema，并在产品界面上增加自动化任务页面，因此随发行版交付的 Web 组合不能默认挂载它们。使用随发行版 Web profile 的人仍需要产品界面上的开关来打开它们；profile patch 层或 `--patch` overlay 都是这个人无法触及的配置文件。

## Decision

`packages/bundle/web-app/cordis.patch.yml` 不含 `time-context`、`schedule` 与 `ui-schedule` 中的任何一行，因此随发行版交付的 Web 组合不挂载任何 Schedule 服务，也不打开自动化任务页面。时钟读数与四个提醒工具改由 preset 拥有：`standard`、`cordis` 与 `ptc` 声明 `time-context` 与 `@deepseek-ai/dsh-tool-schedule`，`minimal` 两者都不声明。这些 preset 的时钟读数无论 bundle 是否启用都生效，而 `dsh-tool-schedule` 会在 `ctx.schedule` 于自身作用域解析之前保持不生效（[按 preset 归属的时间上下文](2026-09-24-preset-scoped-time-context.zh.md)、[按 preset 归属的 Schedule 工具](2026-09-24-preset-scoped-schedule-tools.zh.md)）。

`@deepseek-ai/dsh-experimental-schedule-bundle`（`packages/experimental/schedule-bundle/`）在其 `cordis.patch.yml` 中插入它随附的两行 `schedule` 与 `ui-schedule`，并依赖它们的包，与其他可选 bundle 插入各自随附的行相同。它既不插入也不挂载 `time-context`。`packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES` 列出该包，`apps/cli` 将其声明为运行时依赖，因此每次安装都随包携带且默认关闭。[实验性能力作为可选 bundle 的决策](2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)负责 `OPTIONAL_BUNDLES` 的约定，以及 Web 插件管理页在“官方”分组中渲染的本地化 `icon` 与 `meta.title` / `meta.description` 元数据。

启用该 bundle 会插入 `schedule`（持久提醒）与 `ui-schedule`（Session 提醒目录与自动化任务页面），随后四个提醒工具会在声明 `@deepseek-ai/dsh-tool-schedule` 的 `standard`、`cordis` 与 `ptc` preset 中注册；`minimal` 既收不到工具，也收不到时钟读数。持久记录、投递与管理操作由 [Schedule 子系统](../../../../docs/subsystems/schedule.zh.md)负责；该 bundle 向其加入这些行的组合由 [Web bundle](../../../../packages/bundle/web-app/README.zh.md)负责。禁用该 bundle 会恢复随发行版交付的组合，`schedule` 行不存在期间 Host 不再调度；已存储的任务记录保留在 Schedule domain 中。

## Alternatives considered

**默认发布 Schedule。** 那样 `standard`、`cordis` 与 `ptc` preset 中的每个活跃根 Agent 都要在每个请求头中带上四个工具 schema，从不创建提醒的对话也要承担这项成本。这种安排还让该能力在产品界面上没有关闭开关。

**保留一个 `--patch` overlay 文件。** overlay 是启动时的参数，而不是产品界面上的开关，因此使用随发行版 `web` profile 的人无法触及它。通过它的 `insert` 列表重新声明这些条目并不能覆盖它们：`applyEntryPatches` 追加该列表时不对 id 去重，而 Loader 会把组合出的列表按 id 收敛为一个条目、最后一个声明生效，因此该 overlay 会替换 Web Bundle 的条目，而不是给它们设值。

**把这两行以 `disabled: true` 留在 Web 组合中，用按 id 定位的 patch 打开。** 这样 bundle 只是给已有的行设值，但插件管理器只列出 bundle 插入的行，因此该 bundle 的页面显示不含任何组件，需要为被覆盖的行另建一条列出路径；而其他可选 bundle 都插入各自的行。某个 profile 若也声明了其中某个 id，处理方式与任何其他 bundle 相同：Loader 保留最后一份声明。

**把这两行锁定在 bundle 开关上。** 让插件管理器拒绝逐行开关的 bundle 清单字段，会给插件管理器增加一个只有这个 bundle 使用的概念。该 bundle 的页面像其他所有 bundle 一样为每行提供开关，由 bundle README 说明这两行只能一起工作。

## Consequences

- 默认的 `dsh web` 会话不挂载任何 Schedule 服务：其活跃根 Agent 不带 `schedule_*` 工具 schema，不出现 Session 提醒目录，也不打开自动化任务页面。`standard`、`cordis` 与 `ptc` preset 继续追加各自的逐步时钟读数。需要该服务的安装可从插件管理页启用该可选 bundle，或把该包列进 profile 的 `dsh.profile.bundles`。
- 启用后的安装会给 `standard`、`cordis` 与 `ptc` preset 的活跃根 Agent 增加四个工具 schema，`minimal` 一个都收不到。该读数对模型可见且持久，因此它与其他 user 消息一样参与回放、压缩，并出现在导出的 Session 日志中。
- 插件管理页在该 bundle 下列出 `schedule` 与 `ui-schedule` 两行，显示各自包的 `locale/*.json` 声明的标题、它们的状态，并在 bundle 打开时为每行提供开关；关掉其中一行会让 Schedule 缺少这一部分。
- 未选中该 bundle 时，按 id 定位 `schedule` 或 `ui-schedule` 的 profile 补丁或 `--patch` overlay 匹配不到任何条目，加载器会为它报告 `patch: entry <id> not found` 警告；选中该 bundle 即可取代按 id 打开这些行。
- 该开关只涉及配置：`src/index.ts` 是空模块，运行时内容由 patch 承载，包本身不拥有可变的运行时状态，因此不发布不变量伴随模块。
