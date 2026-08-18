# Agent Note: Client 业务代码使用构建期公开环境变量

Status: implemented

[English](2026-08-18-client-build-environment.md) | 中文

## Problem

浏览器业务包需要按部署构建选择静态行为，但 Web client 有两条互不包含的产物路径：Vite 构建静态壳，共享 tsdown preset 构建运行时加载的动态插件。只在一条路径替换环境变量会使相同业务表达式因所在包类型不同而产生不同结果。

浏览器没有 Node `process`，而把构建进程的完整环境对象放入产物会泄露与前端无关的值。运行时配置也不能准确表达构建变体，因为产物发布后不应再改变这类选择。

## Decision

`DSH_CLIENT_*` 是可公开给浏览器业务代码的构建期命名空间。业务代码可用静态点访问 `process.env.DSH_CLIENT_NAME` 选择行为；值只取自构建进程环境，不读取 Vite `.env*` 文件。设置的值在构建时内联为字符串，未设置的值为 `undefined`。

Vite 配置与动态 client bundle 的共享 tsdown preset 使用同一 define 生成器。生成器只为 `DSH_CLIENT_*` 创建精确替换，并把其余 `process.env` 读取收敛到空对象；浏览器不获得全局 `process`、动态键读取或环境枚举能力。

`DSH_CLIENT_*` 的名称本身表示公开性。凭据、路径和其他仅供 Host 或 CI 使用的值不得使用该前缀。

## Alternatives considered

**只在 Vite 中替换。** 动态插件的 `lib/client.js` 作为独立脚本由浏览器加载，不进入 Vite 模块图，表达式会残留到无 `process` 的浏览器。

**公开全部 `DSH_*`。** 仓库中的 Host、测试和 CI 变量使用该前缀，其中可能包含凭据或本地路径；更窄的 `DSH_CLIENT_*` 让公开意图可审计。

**在浏览器提供完整 `process.env` 对象。** 这会允许枚举构建环境并把 Node 兼容垫片变成运行时 API；静态精确替换足以承载构建选择。

**统一改用 `import.meta.env`。** 动态插件输出为独立 CJS factory，不能保留 `import.meta`；业务代码仍会因产物路径不同而使用两套接口。

## Consequences

Vite 静态壳和共享 tsdown 动态 bundle 对同一 `DSH_CLIENT_*` 构建进程变量产生相同字符串值。未设置的静态点访问得到 `undefined`，非 `DSH_CLIENT_*` 值不会通过该机制进入浏览器产物，业务代码也无法枚举构建进程环境。生成 DSH client 产物的 CI workflow 显式提供所需变量；不生成这些产物的 workflow 不需要携带它们。

任何被业务代码引用的 `DSH_CLIENT_*` 值都会成为公开产物内容，命名错误可能泄露信息。构建选择在产物生成时固定；需要部署后变化的设置必须使用拥有校验、传输和文档的运行时配置机制。
