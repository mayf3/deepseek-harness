# Agent Note: 发布依赖门面与有限 peer 中继

Status: implemented

[English](2026-08-26-published-dependency-faces.md) | 中文

## 问题

一个包可能同时包含浏览器 bundle、Host 入口、共享 TypeScript 声明和 Cordis 注入元数据。把这些关系全部编码成必需 npm peer 会使已发布 CLI 的安装代价过高：npm 会自动安装 peer，并沿深层、反复汇合的 peer 路径重复执行放置检查。修改版本范围或把 peer 标成 optional 都不会消除这类遍历。

Client 构建输入由发布 profile 选择，而 Host value import 由导入它的包通过 Node 加载；两者需要不同的 npm 区段。把规则应用到每个 Host 包虽然也能缩小依赖图，却会制造一个没有对应安装收益的大范围迁移。

## 决策

### 包选择

[`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) 统一负责依赖区段策略。它始终覆盖 `packages/client/` 下的包，以及声明 `dsh.client` 的每个非实验包。该目录包含没有动态 row 的静态 Client 输入，而 `dsh.client` 标识目录外的动态装载包；仅有 `"./client"` export 只是 API，不参与 npm 依赖策略选包。每个选中包的 Host 入口都会接受扫描，包括 `packages/client/` 下的入口。

[`package-dependency-policy.ts`](../../../../scripts/package-dependency-policy.ts) 提供显式 Client 门面 include 与 exclude 列表。include 用于没有 `dsh.client` 的例外包，exclude 用于移除 `packages/client/` 之外自动发现的双面包。验证器拒绝未知、失效、冗余、重复、相互重叠和无法生效的配置项。include 列表为空；exclude 列表包含 `@deepseek-ai/dsh-api-session-controller`，因为把它加回会多迁移九条 Host 边，而五次候选复测的 resolver 中位数仅改善 0.15 秒。

Host-only 包通过另一份显式列表加入同一策略。该列表包含 `@deepseek-ai/dsh-llm` 和 `@deepseek-ai/dsh-session`；源码 import 不会自动扩大列表。

### 依赖区段

每个受管包都把 `@deepseek-ai/cordis` 保持在范围一致的 `peerDependencies` 和 `devDependencies` 中。Cordis 是由应用控制身份的共享插件运行时。

Host 入口闭包中的运行期 value import 所到达的 workspace 包只属于 `dependencies`。Client bundle 使用的 workspace import、纯类型 import、模块扩充、`dsh.client.inject`、invariant companion 和仅有元数据的现存 peer 只属于 `devDependencies`。不属于这些受管关系的现有第三方 dependency 保持原区段。Workspace 引用使用 `workspace:^`。

验证器读取源码 manifest 和源码文件，因此可以在没有已构建 `lib/` 的干净工作树上运行。其 `--fix` 模式只执行分类所确定的区段与范围变更，并删除失效的 peer 元数据。

### 性能验证

[`benchmark-next-package-dependency`](../../../../scripts/benchmark-next-package-dependency.ts) 把当前策略应用到内存中的本地 registry，测量当前 CLI 依赖图，并逐个尝试每个可达且未配置的 Host 包。并发运行用于得到粗筛名单；由于 metadata 请求的完成顺序会让 npm 的 peer 放置搜索走不同路径，最终候选会串行复测。

Benchmark 是手动诊断工具而非 CI 门禁。它在全新 consumer 中执行仅 metadata 的安装，因此相对结果可以定位 peer 中继，但不测量 registry 延迟或包归档下载。

## 考虑过的替代方案

**把内部关系继续保留为 peer。** npm 必须沿汇合的祖先路径放置并验证每个必需 peer；即使内部版本全部兼容，也会重新产生已报告的安装耗时问题。

**用 `"./client"` export 作为 Client 门面名册。** 包可能发布 Client 类型或浏览器 API，却不贡献动态装载 row。选中这类包会把迁移扩大到 Goal、Session Title 和 Todo 等无关 Host 包。`dsh.client` 标识动态 row，而 `packages/client/` 目录独立覆盖静态 Client 输入。

**拍平全部 Host 包。** 这会移除更多 peer 工作，却把迁移扩大到单包 benchmark 收益可忽略的包。显式 Host 列表会保留其余 peer 约束，直到测量结果证明应增加新成员。

**把所有 Client 相关声明都改为仅开发依赖。** 双面包的 Host value import 仍是实际的 Node 加载；从发布依赖图中删掉它们，会让包依赖 profile 的偶然提升。

**在 CI 中强制墙钟阈值。** Resolver 耗时会随机器负载和 metadata 完成顺序变化。确定性的 manifest 分类进入 CI，耗时测量保留为维护者 benchmark。

## 结果

发布依赖图按产物归属而不是源码目录耦合分类。Client bundle 与发布 profile 提供浏览器运行时身份，Host 模块安装自己加载的实体，而 Cordis 是受管包中唯一的全仓 peer。

把公开纯类型关系放进 `devDependencies`，意味着独立 TypeScript 消费者在使用该声明时必须自行安装被引用的类型包。发布 profile 会安装完整的受支持包族；若要支持独立组装的 TypeScript 消费者，需要另一套策略。

显式 override 与 Host 列表都是需要评审的决策。增加例外会改变安装图，因此需要运行聚焦 verifier 测试并重新执行 next-package benchmark。仅 metadata benchmark 是诊断证据，不是发布时安装耗时承诺。
