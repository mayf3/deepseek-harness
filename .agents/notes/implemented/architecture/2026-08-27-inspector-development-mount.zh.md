# Agent Note：Inspector 开发挂载

Status: implemented

[English](2026-08-27-inspector-development-mount.md) | 中文

## Problem

`@deepseek-ai/dsh-experimental-inspector` 是任何已发布 dsh 安装都不携带的 private 包，但开发启动需要按需把它挂进随货 Web 组合。随货 bundle patch 里的一行表达不了这件事：`verify-cordis-config` 要求 bundle patch 中每个具名行都能从该 bundle 自己的 `dependencies` 解析——disabled 行也不豁免——而已发布的 manifest 不得依赖未发布的包。

## Decision

inspector 包自有一份开发 overlay，`packages/experimental/inspector/cordis.patch.yml`，只含一个 `insert` 的 `experimental-inspector` 行。启动通过通用 overlay flag 选它；`pnpm run demo:inspector` 是 `pnpm dsh web --patch ./packages/experimental/inspector/cordis.patch.yml` 的简写。

overlay 只贡献这一行；行的模块在 entry import 时从 profile 平面解析：

- 源码启动（`pnpm dsh`，tsx）经 tsconfig `paths` 门面解析 workspace 包，无需任何安装。
- built 启动（`node apps/cli/lib/bin.js`）需先让包可从 profile import：`dsh plugin --profile web add link:<包目录绝对路径>`，每个 profile 一次。`link:` 让依赖解析留在真实包目录内；`file:` 会在 profile 里重装该包的 `workspace:^` 依赖并以 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` 失败。

profile 无法 import 该包的启动会在 entry import 处响亮失败（`Cannot find package '@deepseek-ai/dsh-experimental-inspector' imported from <profile dir>`）；不存在静默跳过。

## Consequences

已发布的包不携带 inspector 的任何痕迹：没有 manifest 条目、没有组合行、没有 launcher flag。挂载保持按次启动选择——不带 overlay 的同一服务永远不会加载该包——且启动组合的每一层都由 config 文件声明。代价是启动方式不对称：built 启动需要一次性 profile `link:` 安装，且每次调用都要点名 overlay，常见场景由 `pnpm run demo:inspector` 吸收。

## Alternatives considered

- 随货 web-app patch 里放 `disabled: !!js` 行：依赖门禁与 npm 发布都会把 private 包逼进已发布 manifest。
- `--inspector` launcher flag 把包挂成额外 bundle 层：launcher 既不拥有 app flag 也不拥有插件包名。
- `dsh-web-app` 上加 optional `peerDependencies` 并由其 glue 插件动态 `ctx.loader.create`：向已发布 manifest 写入永不发布的名字，且挂载的行不在任何 config 层声明。
