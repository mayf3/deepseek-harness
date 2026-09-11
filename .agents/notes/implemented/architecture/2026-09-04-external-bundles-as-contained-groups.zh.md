# Agent Note: 外部组合包挂载为受控组，行 id 有归属

Status: implemented

[English](2026-09-04-external-bundles-as-contained-groups.md) | 中文

## 问题

用 `dsh plugin add` 安装的组合包，其行的挂载方式与安装自带的行完全一样：追加到根条目列表，用它的 patch 声明的 id，位于构建整棵树的那一个 Loader 事务里。vendored Loader 的形态由此带来三个后果。`EntryGroup.update` 是整组事务——一行被拒就回滚整组并重新抛出——于是一个不再能在当前 harness 上编译的社区插件会让每一个 `dsh` 表面都起不来，而诊断信息点名的是行，不是组合包。entry id 在整棵树内唯一（`tree.store`），`create()` 发现已有 id 时会把那个 entry 挪到新组之下并替换其 options，于是两个都插入 `id: hello` 的组合包，第二个会静默接管第一个。没有任何记录说明某一行由哪一层插入，因此插件列表既分不出内置行与已安装行，也分不出用户停用的行与组合门控的行。

## 决定

**每个外部组合包就是一个组。** profile launcher 按来源给每一层分类：作为 profile 的 pnpm 依赖存在的组合包是 `external`，模板组合包或 profile 在 `dsh.profile.firstParty` 下列出的是 `builtin`。`composeExternalLayer` 把 `runtime` 阶段的外部层渲染成一个 `cordis:contained-group` 条目 `bundle/<package>`，先空着插入，随后按书写顺序跟着组合包自己的 patch：根级插入改为插进这个组，插入同一个内置组的行全部落进目标组内嵌套的同一个受控包装组（替换目标组 config 的 patch 会把这个包装组一并清掉，之后的插入会在同一个 id 下新建一个），按 id 定位的 patch 原样通过，指向它没有引入的行时报告为覆盖。按 id 定位的 patch 设成某个组 config 的行算作组合包自己引入的行：它们和插入的行一样作为子行挂载。这一层引入的每个 id，无论声明的还是生成的，都经过同一次登记，因此一行写成组或包装组的 id 就是重复。保持书写顺序，才能让"先替换某个组的 config 再向它追加"这样的 patch 在两种 stage 下含义一致。组 id 用 `/` 而不是 `:`，因为 `:` 是 Loader 的嵌套 id 分隔符。

**行 id 有归属，不改写。** `composeProfileStack` 在任何行挂载之前判定归属：一层引入的行包括它插入的行和它的 config 覆盖设为某个组子行的行；内置层与 boot 阶段的层先占有 id，它们之间重复即启动失败，而 config 覆盖重述同一层已声明的行只是这一层保留自己的子行；受控组合包声明了别的层已占有的 id、或把自己的某个 id 声明了两次时整层排除；用户层插入已被占用的 id 时该行丢弃，用户覆盖里的行由用户自己重述。被排除的行就是这次组合的冲突，每条自带消息：启动时打到 stderr，由 `ProfileRuntime` 作为已提交组合的一部分持有，在插件列表里按包显示。它们从不进入 `pluginFailures`，那里的记录只指真正到达 Loader 的行。启动、运行时重组与 `--dump-config` 走同一个函数，它把每个受控层只渲染一次，并一并返回 patch、每个 id 的归属与冲突。

**受控组隔离行的失败。** `ContainedGroup extends Group` 覆盖 `create()`——这是事务性 `update()` 逐行等待的那一步：被拒的行记录到根上的 `pluginFailures` 注册表——树内 id、声明的行 id、模块、组、从 Loader 包装信息解析出的阶段、消息——组在没有它的情况下激活。记录写明隔离该行的受控组，中间隔着多少普通组都一样。组更新时，配置里不再有的行的记录随之丢掉；组卸载时——它的组合包被停用或卸载——它所有行的记录一并丢掉，因此没有失败会比产生它的组合活得更久。`assertEntriesActivated` 豁免受控行（失败或 pending 的行变成一条记录），内置行保留致命路径。一条兜底规则封住"隔离反而藏起核心已坏"的 corner case：只要有组合包被隔离，而某个内置行停在 pending，启动仍然失败，诊断点名被隔离的组合包以及 `stage: boot` 这条出路。

**`stage: boot` 是显式的退出隔离。** 若组合包的行提供内置行所注入的服务，作者在 manifest 里声明 `dsh.bundle.stage: boot`，或部署者在 profile manifest 里设置 `dsh.profile.stages`，后者优先；这样的层不包组、按致命语义挂载。未知的 stage 值让 profile 加载失败。

**安装与启用是两件事。** `reconcileInstalledBundles` 不再无条件把每个声明了组合包的依赖追加进 `dsh.profile.bundles`；`autoEnable` 保留 CLI 装即启用的语义，`enableBundle`/`disableBundle` 是插件管理器调用的 manifest 操作。`dependencies` 记录安装，`bundles` 记录已启用的层。

**来源与重组是同一个 launcher 服务。** `ProfileRuntime`（`ctx.profileRuntime`）持有已提交的组合——profile、每个行 id 的归属（`originOf`）与冲突——读取用户 patch 文件用字面量 `disabled: true` 停用了哪些行，并且是重组整棵树的唯一入口：它先组合候选结果，经根 include 应用，只有 include 接受之后才发布候选结果，因此被拒的更新留下的事实仍然描述正在运行的树；重组一次只跑一个，后一次读取前一次提交的结果，所以启用组合包期间触发的监视器重组的是启用后的树而不是之前那棵。patch 监视器调用它的 `recompose`，不再自己组合。插件清单读取它与失败注册表，为每一行提供 `trust`、`package`、`disabledBy` 与 `failure`，并列出冲突以及只有注册表知道的行。

## 考虑过的替代方案

**给 `EntryOptions` 加 `optional` 字段并教 vendored 的 `EntryGroup.update` 跳过它。** 精确，但是一处每次同步都要登记并重新施加的 vendored 分歧，是 `verify-cordis-config` 要放行的新元数据字段，而且仍然不能给组合包在树里一个身份。否决：Loader 自己的 `builtins` 位置已经允许 launcher 替换组类，而"每个组合包一个组"正是之后每个功能——包级开关、按包报告失败——所需要的身份。

**为外部组合包增加第二个启动阶段，由运行时插件在内置树起来之后挂载。** 隔离最干净，也不用改写组合，但每个提供内置 seam 服务的组合包反正都需要显式逃生口，会话可能在第二阶段落地前就开始，浏览器 roster 也要重算。否决：同样的结果却是更大的改动；受控组保住了单一启动事务。

**给每个外部行 id 加包名前缀。** 先实现后撤回：它让撞名不可能发生，但用户 patch、往用户层写 `disabled` 行的第三方管理器、以及组合包自己拿 `e.options.id` 比较的 `!!js` 表达式，全都按声明 id 寻址并静默落空——deep-whale 皮肤管理器的互斥行和 pi-ai OAuth 组合包的自排除门控（自己的 id 不再匹配后递归到栈溢出）都是这样坏掉的——而 `--dump-config` 组合的是未加前缀的层，dump 与启动不一致。带响亮冲突的归属让声明 id 处处一致，并把撞名变成看得见的记录。

**保持 id 不加前缀，依赖作者自己选唯一 id。** 否决，因为失败形态是静默接管，不是报错；归属检查正是让不加前缀变得安全的那一步。

## 后果

harness 升级后损坏的社区组合包不再让 `dsh` 停下；插件列表显示失败的行及其阶段与消息，进程继续服务。两个声明同名行 id 的组合包不能同时挂载：`dsh.profile.bundles` 里靠前的保住它，靠后的被排除并留下冲突记录，卸掉靠前的组合包后靠后的在下次启动时挂上。用户 patch 按组合包声明的 id 定位它的行，`--dump-config` 显示受控组并报告同样的冲突，组合包的 `!!js` 表达式看到的是自己声明的 id。组合包对内置行的覆盖留在隔离之外，因为它原地修改那一行。能抓住内置条目下失败的 `ctx.inject()` 延续的嵌套 fiber 审计以提示行交付；改为致命要等对随附组合做一轮检查。

## 测试

`packages/boot/app-boot/tests/external-bundles.spec.ts` 钉住组合（分组、声明 id、书写顺序、覆盖、每个内置目标一个包装组、重复 id、不改动层自己的 patch）与 manifest 操作；`tests/compose-stack.spec.ts` 钉住归属：内置重复抛错，撞名或重复声明 id 的外部组合包整层排除，用户插入已占用 id 时丢弃，冲突记录替换上一次组合的记录。`tests/contained-group.spec.ts` 启动真实的树：受控行失败被记录而其兄弟行与内置行运行，pending 的受控行被记录，内置失败仍然 reject，被隔离组合包旁边停在 pending 的内置行 reject 并点名它，稍后重载时失败的受控行由审计记录。`tests/profile.spec.ts` 钉住 trust 与 stage 的解析，包括部署者覆盖与未知 stage 的拒绝；`tests/profile-runtime.spec.ts` 钉住来源与重新组合；`packages/host/plugin-inventory/tests/inventory.spec.ts` 钉住新的行字段。
