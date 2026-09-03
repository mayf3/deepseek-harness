# Agent Note：外部组合包挂载为受控的、带前缀的组

Status: implemented

[English](2026-09-04-external-bundles-as-contained-groups.md) | 中文

## 问题

用 `dsh plugin add` 安装的组合包，其行的挂载方式与安装自带的行完全一样：追加到根条目列表，用它的 patch 声明的 id，位于构建整棵树的那一个 Loader 事务里。vendored Loader 的形态由此带来三个后果。`EntryGroup.update` 是整组事务——一行被拒就回滚整组并重新抛出——于是一个不再能在当前 harness 上编译的社区插件会让每一个 `dsh` 表面都起不来，而诊断信息点名的是行，不是组合包。entry id 在整棵树内唯一（`tree.store`），`create()` 发现已有 id 时会把那个 entry 挪到新组之下并替换其 options，于是两个都插入 `id: hello` 的组合包，第二个会静默接管第一个。没有任何记录说明某一行由哪一层插入，因此插件列表既分不出内置行与已安装行，也分不出用户停用的行与组合门控的行。

## 决定

**每个外部组合包就是一个组。** profile launcher 按来源给每一层分类：作为 profile 的 pnpm 依赖存在的组合包是 `external`，模板组合包或 profile 在 `dsh.profile.firstParty` 下列出的是 `builtin`。`composeExternalLayer` 把 `runtime` 阶段的外部层渲染成一个 `cordis:contained-group` 条目 `bundle/<package>`，其中放着组合包插入的行，id 带 `<package>/<id>` 前缀；插入内置组的行在目标组内嵌套自己的受控组，组合包按 id 定位的 patch 在指向自己的行时改写为前缀后的 id，在指向内置行时原样通过。用 `/` 而不是 `:`，因为 `:` 是 Loader 的嵌套 id 分隔符。

**受控组隔离行的失败。** `ContainedGroup extends Group` 覆盖 `create()`——这是事务性 `update()` 逐行等待的那一步：被拒的行记录到根上的 `pluginFailures` 注册表——树内 id、声明的行 id、模块、组、从 Loader 包装信息解析出的阶段、消息——组在没有它的情况下激活。`assertEntriesActivated` 豁免受控行（失败或 pending 的行变成一条记录），内置行保留致命路径。一条兜底规则封住"隔离反而藏起核心已坏"的 corner case：只要有组合包被隔离，而某个内置行停在 pending，启动仍然失败，诊断点名被隔离的组合包以及 `stage: boot` 这条出路。

**`stage: boot` 是显式的退出隔离。** 若组合包的行提供内置行所注入的服务，作者在 manifest 里声明 `dsh.bundle.stage: boot`，或部署者在 profile manifest 里设置 `dsh.profile.stages`，后者优先；这样的层不包组、不加前缀、按致命语义挂载。未知的 stage 值让 profile 加载失败。

**安装与启用是两件事。** `reconcileInstalledBundles` 不再无条件把每个声明了组合包的依赖追加进 `dsh.profile.bundles`；`autoEnable` 保留 CLI 装即启用的语义，`enableBundle`/`disableBundle` 是插件管理器调用的 manifest 操作。`dependencies` 记录安装，`bundles` 记录已启用的层。

**来源是 launcher 的服务。** `ProfileRuntime`（`ctx.profileRuntime`）持有已启动的 profile，把每一行归属到插入它的层（`originOf`，含前缀 id），读取用户 patch 文件用字面量 `disabled: true` 停用了哪些行，并经根 include 重新组合整棵树——patch 监视器走的正是同一条路。插件清单读取它与失败注册表，为每一行提供 `trust`、`package`、`disabledBy` 与 `failure`，并列出只有注册表知道的行。

## 考虑过的替代方案

**给 `EntryOptions` 加 `optional` 字段并教 vendored 的 `EntryGroup.update` 跳过它。** 精确，但是一处每次同步都要登记并重新施加的 vendored 分歧，是 `verify-cordis-config` 要放行的新元数据字段，而且仍然不能给组合包在树里一个身份。否决：Loader 自己的 `builtins` 位置已经允许 launcher 替换组类，而"每个组合包一个组"正是之后每个功能——包级开关、按包报告失败——所需要的身份。

**为外部组合包增加第二个启动阶段，由运行时插件在内置树起来之后挂载。** 隔离最干净，也不用改写组合，但每个提供内置 seam 服务的组合包反正都需要显式逃生口，会话可能在第二阶段落地前就开始，浏览器 roster 也要重算。否决：同样的结果却是更大的改动；受控组保住了单一启动事务。

**保持 id 不加前缀，依赖作者自己选唯一 id。** 否决，因为失败形态是静默接管，不是报错。

## 后果

harness 升级后损坏的社区组合包不再让 `dsh` 停下；插件列表显示失败的行及其阶段与消息，进程继续服务。两个组合包可以声明同名行 id。针对外部组合包某行的用户 patch 必须写前缀后的 id，`--dump-config` 会显示该组；把 `e.options.id` 与组合包自己未加前缀 id 比较的 `!!js` disabled 表达式不再匹配——比较 `e.options.name` 是文档化的写法。组合包对内置行的覆盖留在隔离之外，因为它原地修改那一行。能抓住内置条目下失败的 `ctx.inject()` 延续的嵌套 fiber 审计以提示行交付；改为致命要等对随附组合做一轮检查。

## 测试

`packages/boot/app-boot/tests/external-bundles.spec.ts` 钉住组合（分组、前缀、patch 改写、嵌套插入、不改动层自己的 patch）与 manifest 操作。`tests/contained-group.spec.ts` 启动真实的树：受控行失败被记录而其兄弟行与内置行运行，pending 的受控行被记录，内置失败仍然 reject，被隔离组合包旁边停在 pending 的内置行 reject 并点名它，稍后重载时失败的受控行由审计记录。`tests/profile.spec.ts` 钉住 trust 与 stage 的解析，包括部署者覆盖与未知 stage 的拒绝；`tests/profile-runtime.spec.ts` 钉住来源与重新组合；`packages/host/plugin-inventory/tests/inventory.spec.ts` 钉住新的行字段。
