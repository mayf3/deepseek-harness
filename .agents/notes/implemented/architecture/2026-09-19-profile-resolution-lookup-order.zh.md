# Agent Note: profile 解析的主线祖先链与拦截层

Status: implemented

[English](2026-09-19-profile-resolution-lookup-order.md) | 中文

## Problem

profile 从自己的包项目加载插件。dsh 本体包和 bundle 内嵌的依赖不在 profile 的依赖树上，Node 默认的 `node_modules` 查找从 profile 出发找不到它们。

解析规则需要能被开发者一句话复述：哪一段是普通 Node 行为，哪一段是 dsh 的干预，干预的范围到哪里为止。此前的运行时实现把 `$DSH_HOME/profiles/node_modules` 整层对所有包名隐藏，又为历史目录形状保留了专门的识别代码，规则无法用一句话说清，也无法判断某次解析结果是否符合预期。

## Decision

profile 内模块的解析是一条普通的 Node 祖先 `node_modules` 链。dsh 只做一件事：启动时算出的 runtime resolution 中的每个包名，占据 `$DSH_HOME/profiles/node_modules/<包名>` 这个包目录的位置。链走到这一层时，有条目的包名由 runtime resolution 的包回答，没有条目的包名看这一层的物理目录。link 到树外的插件把同一形式的拦截层带到自己的真实目录：runtime resolution 中被该插件声明为 peer 的包名，占据 `<真实目录>/node_modules/<包名>` 的位置。除此之外的一切解析行为与 Node 一致。[不可变 generation 的构造、发布、Worker 继承与运行时载体](2026-09-09-profile-resolution-generations.zh.md)由既有 Note 记录，本篇不复述。

### 一、解析规则

#### 1. 主线：Node 的祖先 `node_modules` 链

importer 指发起 `import` 或 `require` 的那个模块文件。Node 从 importer 所在目录开始，逐层向上尝试每一级目录下的 `node_modules`，直到文件系统根，再尝试 `NODE_PATH` 与全局目录。最近的一层优先；同一层内只按包名匹配。

软链接按 Node 默认行为跟随到真实路径。一个模块一旦以真实路径加载，它后续 import 的主线就是真实路径的祖先链，与它被链接到哪里无关。

下面这条链是全文表格引用的编号。importer 为 `$DSH_HOME/profiles/web/node_modules/my-plugin/index.js`：

```text
① $DSH_HOME/profiles/web/node_modules/my-plugin/node_modules
② $DSH_HOME/profiles/web/node_modules
③ $DSH_HOME/profiles/node_modules
④ $DSH_HOME/node_modules
⑤ /node_modules
```

① 是插件私有依赖，② 是 profile 安装的包，③ 是拦截层，runtime resolution 占据其中有条目的包目录，④ 是 Harness home，⑤ 是文件系统根，随后是 `NODE_PATH` 与全局目录。

#### 2. 拦截层：runtime resolution 占据 `$DSH_HOME/profiles/node_modules/<包名>`

拦截层是 importer 所属 profile 目录（`$DSH_HOME/profiles/<name>`）之上的第一个祖先 `node_modules`。树内所有 profile 的这一层都是 `$DSH_HOME/profiles/node_modules`。

runtime resolution 中的每个包名，在这一层上占据 `<拦截层>/<包名>` 这个包目录的位置。对 `@deepseek-ai/dsh-tools` 这样的本体包名，③ 上的包目录就是运行中安装的那一份；磁盘上同名的旧链接或旧目录不再是链上的成员。对 runtime resolution 没有的包名，③ 上的包目录就是磁盘上的物理内容。

一次裸包名请求的顺序：主线先走完 profile 目录内部的各层（①②），有候选就交给 Node 在候选内解析并返回。走到 ③ 时，runtime resolution 有该包名的条目，Node 就在条目记录的包目录内解析；找到就返回，包内缺文件则按 Node 自身对"已找到包"的处理继续，CommonJS 从 ④ 继续逐层找子路径，ESM 直接报错。runtime resolution 没有条目，Node 就看 ③ 的物理目录，再到 ④。

Node 仍然负责 `exports`、`imports`、conditions、`main`、子路径、扩展名、缓存与错误码。被选中的包因 `exports` 拒绝某个子路径时报错终局，不会换另一个同名包。

拦截层不读、不写、不删任何磁盘链接。历史残留的软链接一律按普通文件系统内容处理：本体包名在 ③ 上的位置已被 runtime resolution 占据，旧链接永远不会被读到；其余包名按主线正常看到 ③ 里的内容。profile 加载时一次性删除 dsh 0.1.5 系列发布版的 Link 后端写进 profile 的投影：profile `node_modules` 下目标位于 `<profile>/.dsh-module-fallback/node_modules` 内的软链接，以及该目录本身。pnpm 安装的包和其他软链接都保留。

#### 3. link 到树外的插件：拦截层在插件真实目录的 `node_modules`

`<profile>/node_modules/<包名>` 是软链接且真实目标 R 在 profiles 树外时，R 是一个 linked root。R 之下的 importer 走 R 的真实祖先链，拦截层是 `R/node_modules`：链上更深的 `node_modules`（pnpm `.pnpm/` 内传递依赖自己的那层）是本地层，`R/node_modules` 之上是 `parent(R)/node_modules` 直到文件系统根，都按 Node 处理。

这一层上被占据的包名只有一部分：`R/package.json` 的 `peerDependencies` 里、且 runtime resolution 有条目的包名。插件把需要与宿主共享实例的 dsh 包声明为 peer；查找走到这一层时，由运行中的 dsh 提供该包，为类型检查安装在这个位置的同名 devDependency 副本不会被加载。只声明为 `dependencies`、未声明为 peer 的包名不被占据，插件自己安装的第三方版本照 Node 规则最近者优先，与树内 ①② 赢 ③ 一致。

peer 集合在每次解析时从 `R/package.json` 读取，不在 runtime resolution 构造时固定，linked importer 的路由也不做 memo：开发者改完 `peerDependencies` 后，重新加载插件时的新解析会读取新声明。这不清除 Node 的模块缓存，也不自动监视插件文件。未被占据的包名从 `R/package.json` 锚点交给 Node，即 `R/node_modules` 的物理内容再沿 R 的真实祖先链。linked root 的集合在 runtime resolution 构造时扫描 `<profile>/node_modules` 的顶层与 `@scope/*` 条目得到；successor 可以在既有包映射和本地包名约束内新增或移除 linked root，同名 link 换了真实目标则拒绝发布并要求重启，因为 Node 缓存 realpath。`R/package.json` 不可读时这一层不占据任何包名，诊断由 Node 报出。

#### 4. 拦截层里有什么：runtime resolution 的扫描内容

runtime resolution 在 profile 启动时一次算出，由四部分组成。

- installation 闭包：从当前运行的 dsh 包的 `package.json` 出发，沿 `dependencies` 与 `peerDependencies` 做广度优先遍历，每条边从声明它的 manifest 按 Node 规则解析，同一个包名由第一次找到的已安装包占有。闭包有数百条，约一半在 `@deepseek-ai/` 作用域，一半是第三方库。这些条目对所有 profile 生效。
- bundle-only 条目：profile 选中的、不属于闭包的 bundle，从它的 manifest 出发做同样的遍历，闭包已占有的包名不覆盖。这些条目只对选中该 bundle 的 profile 生效，用于让 Loader 从 profile 根按裸名导入 bundle 内嵌的插件。
- 本地包名：profile 直接依赖中已经安装在 `$DSH_HOME/profiles/<name>/node_modules` 的包名。它们本来就在主线 ② 上，记录下来只为免去一次目录探测。
- linked root：`$DSH_HOME/profiles/<name>/node_modules` 顶层与 `@scope/*` 里目标位于 profiles 树外且含 `package.json` 的软链接，记录真实目录与 link 位置。目标仍在 profiles 树内的软链接不记录，主线已经覆盖它。

CLI 的安装锚点来自 `import.meta.url`，Node 已对它做过 realpath；Desktop Host 从其运行时目录拼出锚点，该目录不是软链接。两者的安装根目录都等于真实目录，bundle 发现与依赖遍历使用同一个位置。遍历中每一层依赖都以所属包的真实目录作为下一层的查找锚点，并记录声明它的 manifest 位置。命中后 Node 从这个声明位置解析，得到与该包自己内部 import 相同的结果。每个条目记录包名、包目录、版本、声明位置与作用域。已声明但未安装的依赖跳过；bundle 包根自身不成为条目。

#### 5. hook 覆盖范围

hook 只在 importer 位于 `$DSH_HOME/profiles/**` 或某个 linked root 之下时参与。builtin、相对路径、绝对路径、URL 请求，以及 importer 在这两处之外的一切请求，直接交给 Node。

ESM 与 CommonJS 两个适配器调用同一个路由函数，主线程与 Harness 自有 Worker 都安装同一份 runtime resolution。实现位于 `packages/boot/app-boot/src/profile-resolution/resolver.ts`，runtime resolution 的构造位于 `packages/boot/app-boot/src/profile.ts`。

### 二、预演

#### 表 1：ESM 与 CommonJS 在各类请求下的主线与拦截

下表以本体包 `@deepseek-ai/dsh-tools`（runtime resolution 有条目）和第三方库 `left-pad`（runtime resolution 无条目）为例；`pkg` 泛指两者。

| 请求形态 | ESM | CommonJS | ③ 上该包名的位置 | 包内缺文件时 |
|---|---|---|---|---|
| 裸包名 `pkg`，包有 `exports` | ①② 有 `pkg` 目录则 Node 在其中按 `exports` 取入口 | 同 ESM；①② 的候选目录缺入口文件时不算候选 | 有条目：runtime resolution 的包；无条目：物理目录 | 有 `exports` 的入口缺失是 `exports` 错误，终局 |
| 裸包名 `pkg`，包无 `exports` | 同上，入口取 `main` 或 `index` | 同上 | 同上 | ESM 终局报错；CommonJS 从下一层继续找入口 |
| 子路径 `pkg/sub`，包有 `exports` | 第一个找到的 `pkg` 决定；`./sub` 未导出则 `ERR_PACKAGE_PATH_NOT_EXPORTED` 终局 | 同 ESM | 同上 | 终局，不找别的副本 |
| 子路径 `pkg/sub`，包无 `exports` | 第一个找到的 `pkg` 内没有 `sub` 则 `ERR_MODULE_NOT_FOUND` 终局 | 逐层尝试 `<层>/pkg/sub`：①②，然后 ③ 上该包名的位置（有条目即 runtime resolution 的包目录），然后 ④ | 同上 | ESM 终局；CommonJS 继续下一层，即 ④ |
| `#alias` 包内别名 | 所属 manifest 的 `imports` 映射到裸包名后，按上面各行处理；映射到相对路径则直接交 Node | 同 ESM，conditions 取调用方传入或默认值 | 同对应行 | 同对应行 |
| `require.resolve(pkg, { paths })` | 无此形式 | 对 `paths` 中每一项独立套用同一规则：项在 profile 树内则从该项出发走 ①②、③、④；项在树外交 Node；按调用方给出的顺序 | 同上 | 该项继续下一层，再轮到下一项 |
| 包自引用（importer 所属包按自己的 `name` import） | 交 Node，保留原 importer | 同 ESM | 不参与 | 不适用 |
| 相对 / 绝对 / URL / builtin | 交 Node | 交 Node | 不参与 | 不适用 |

命中 runtime resolution 后，Node 报出的 `ERR_MODULE_NOT_FOUND` 与 `ERR_PACKAGE_PATH_NOT_EXPORTED` 会把内部的声明位置替换回原 importer；CommonJS 的 require stack 也去掉内部锚点。

#### 表 2：Web 与 Desktop 两种 profile 的拦截位置

| profile | 目录 | 拦截层 | 与 web 的差异 |
|---|---|---|---|
| web | `$DSH_HOME/profiles/web` | `$DSH_HOME/profiles/node_modules` | 基准 |
| desktop | `$DSH_HOME/profiles/desktop` | `$DSH_HOME/profiles/node_modules` | 无。同一棵树、同一层；Desktop 的 Host 以 Node 模式运行同一套 resolver |
| 树外 profile | `loadProfileDirectory` 接受的任意目录 | 该目录之上的第一个祖先 `node_modules` | 规则相同；当前没有产品使用树外 profile，只有单元测试覆盖 |

#### 表 3：插件被 link 到树外时的主线

插件 `my-plugin` 被 `<profile>/node_modules/my-plugin` 链接到真实目录 R；R 的 manifest 把 `@deepseek-ai/dsh-tools` 声明为 peer 并装成 devDependency，把 `zod` 声明为 dependency。

| import 来源 → 目标 | hook 是否参与 | 结果 |
|---|---|---|
| profile → 链接的插件 | 参与到 ② 为止 | ② 的软链接被 Node 跟随，插件以真实路径加载 |
| 链接插件 → `zod` | 参与，`R/node_modules` 上 `zod` 未被占据 | `R/node_modules/zod`，开发者自己安装的版本 |
| 链接插件 → `@deepseek-ai/dsh-tools`（peer） | 参与，`R/node_modules` 上该名被占据 | 运行中的 dsh 的那一份；`R/node_modules` 里的 devDependency 副本不被读到 |
| 链接插件 → 只声明为 dependency 的有状态 dsh 包 | 参与，未被占据 | `R/node_modules` 里自己的副本，产生第二个实例；与树内把 dsh 包装进 ② 的错误相同，改为 peer 即可 |
| 链接插件 → 未声明的包名 | 参与，未被占据 | `R/node_modules` 的物理内容，再沿 R 的真实祖先链 |
| R 内传递依赖 → 任何包名 | 参与 | 先它自己的本地层，再同上；占据集合仍取 `R/package.json` 的 peer |

### 三、开发者接入指引

#### 1. 正常安装

`dsh plugin --profile <name> add <包名 | git spec | file:../本地检出>` 把参数转发给 pnpm，在 profile 目录内以 hoisted 布局安装。profile 的 `pnpm-workspace.yaml` 设置 `autoInstallPeers: false`，插件声明为 peer 的 dsh 包不会被装进 profile，由拦截层提供当前运行安装的那一份，插件与 dsh 共用同一个模块实例。

插件自己的第三方依赖被 hoist 到 `$DSH_HOME/profiles/<name>/node_modules`，按主线 ② 找到。与 installation 闭包同名时最近者优先，插件使用自己声明的版本。`file:` 形式把本地检出复制进 profile，随后的解析与注册表安装完全相同。

#### 2. 开发模式：插件仓库在 profile 树外

`npm link`，或 `dsh plugin add ../my-plugin` 这类裸目录路径（pnpm 按 `link:` 处理），会让 profile 里的条目成为指向插件仓库的软链接，仓库目录成为 linked root。插件以真实路径加载，第三方依赖用仓库里自己安装的版本；声明为 peer 的 dsh 包由 `R/node_modules` 上的拦截层提供运行中的那一份，与 dsh 的来源无关：npm 全局安装、Desktop 内置或源码仓启动都一样。仓库里为类型检查安装的 dsh devDependency 只服务编译器，运行时不会被读到。

manifest 的写法与 harness 自身的包相同：需要与宿主共享实例的 dsh 包同时声明在 `peerDependencies` 与 `devDependencies`，peer 让 `R/node_modules` 上的位置被占据，dev 副本给编译器和独立测试使用；第三方依赖以及 `@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-util-values` 这类无状态 dsh 工具包放在 `dependencies`。修改 `peerDependencies` 后，重新加载插件时的新解析会使用新声明；已加载模块的生命周期仍由 Node 和 Cordis 管理。

另两种可用布局：插件仓库自装 `@deepseek-ai/dsh` 并从仓库里启动 `pnpm exec dsh --profile <name>`；或把 dsh 包 link 到本机源码仓并从源码仓启动。两者让运行中的 dsh 与仓库里的副本本来就是同一份，但 linked 插件不要求使用这两种布局。

## Alternatives considered

**让 runtime resolution 只在主线全部走完后兜底。** 主线会先在 ③ 读到历史残留的本体链接并使用它，与"本体以当前运行的安装为准"冲突。runtime resolution 必须占据 ③ 上本体包名的位置。

**把 runtime resolution 当作插入主线的一整层，而不是占据 ③ 上的包目录。** 两者只在一处不同：CommonJS 命中 runtime resolution 的包后子路径缺失时，前者会再回头读 ③ 上同名的旧副本，后者按 Node 对"已找到的包"的处理直接到 ④。占据包目录与 Node 语义一致，也不需要为 ③ 保留任何额外判断。

**让 installation 闭包条目绝对优先于更近的副本。** 闭包含 281 个第三方库。插件私有的 `zod`、`yaml` 等版本会被安装闭包里的版本覆盖，破坏与 Node 一致的最近者优先。受支持的安装流程已经不把 dsh 的 peer 装进 profile，不需要再用覆盖来保证单实例。

**在解析时识别 `.dsh-module-fallback` 形状的软链接并绕过。** 这会为不再产生的目录在查找路径里保留专门逻辑，每次解析都要付出判断。在 profile 加载时一次性删除这些投影能得到同样的结果：一个 bundle 被停用但仍装着时，它投影出来的插件不再遮住 runtime resolution 从另一个 bundle 选出的同名插件。

**把拦截层所在的物理目录整层隐藏。** 与"其余解析与 Node 一致"冲突：放在 `$DSH_HOME/profiles/node_modules` 的非本体包会对所有 profile 不可见。

**让 runtime resolution 的全部条目占据 `R/node_modules` 上的包目录。** 与 ③ 完全同形，但闭包里的几百个第三方库会遮住插件仓库自己安装的 `zod`、`yaml` 版本，与树内 ①② 赢 ③ 相反。只占据 peer 保住了「插件自己的第三方版本优先」。

**按 importer 最近的 manifest 的 `dependencies` 决定哪些包名走原生。** 能模拟「装进 profile 后不装 devDependencies 与 peer」的效果，但每次解析都要为 importer 找最近的 manifest，规则也不再与 ③ 同形。占据 peer 的做法只读 linked root 一份 manifest。

**在 runtime resolution 构造时固定 peer 集合。** 开发者改一次 `peerDependencies` 就要重启 dsh。解析时读取让重载插件即可生效，代价是开发模式下每次路由多一次小文件读取。

**把 linked root 之上的主线接回 profile 的 ②③。** 这是 Node `--preserve-symlinks` 的形式，`R/node_modules` 仍是原生的第一层，devDependency 副本照样先被找到，单实例问题原样保留。

## Verification

- [profile-resolution.spec.ts](../../../../packages/boot/app-boot/tests/profile-resolution.spec.ts) 中的表驱动矩阵：importer 取 profile 根与 profile 内插件，包名取 installation 条目、bundle-only 条目与表外包名，①②③④ 四层的每一种有无组合，②③ 各含真目录与指向别处的软链接两种形态；每格断言 ESM import、CommonJS require、`require.resolve` 与 `packageDir` 元数据落在同一个目录。
- 同一文件内的 linked root 用例：`<profile>/node_modules` 的软链接指向树外仓库，仓库 `node_modules` 里放同名 devDependency 副本；包名取声明为 peer 的 installation 条目、声明为 dependency 的 installation 条目、仓库自己的第三方 dependency、未声明的包名，importer 取仓库自身文件与仓库内传递依赖；断言四种解析方式一致、devDependency 副本不被读到，以及改写 `peerDependencies` 后下一次解析立即按新声明进行。
- 同一文件内的专项用例覆盖表 1 各行：有无 `exports` 的裸包名与子路径、`#alias`、显式 `paths`、包自引用、命中 runtime resolution 后 CommonJS 子路径缺失时跳过 ③ 直接到 ④，以及树外 profile 的拦截位置。
- [CLI 真启动测试](../../../../apps/cli/tests/profiles/headless/tests/profile-resolution.ts)在 src 与 lib 两种启动、普通目录与 npm-link 两种布局下，放置 ③ 的旧 `@deepseek-ai/dsh-tools` 链接、③ 的外部包及其内嵌依赖，npm-link 布局再给 link 出去的插件放一份 `@deepseek-ai/dsh-tools` devDependency 副本并声明为 peer；断言 Tools 与 AgentLoop 共用同一模块实例、link 出去的插件拿到的 Tools 也是这一份、外部包沿真实路径解析、所有文件与链接目标逐字节不变。

## Consequences

买到的：模块解析无需磁盘投影；命中拦截层的 dsh 本体包来自当前运行的安装，link 到树外的插件声明的 peer 也适用；其余解析保留 Node 的祖先链和包入口规则；解析路径不识别历史投影目录。

付出的：installation 闭包里的第三方库仍占据 ③ 上的包目录，profile 插件把第三方库声明成 peer 或漏声明时会拿到 dsh 内部使用的版本，与磁盘链接时代相同，插件应把第三方库声明成 dependency；link 到树外的插件只有声明为 peer 的 dsh 包由运行中的 dsh 提供，声明为 dependency 的仍是自己的副本；只有 `<profile>/node_modules` 的直接软链接成为 linked root，插件仓库再 link 出去的依赖、npm workspace 提升到仓库之外的依赖不在任何 linked root 下，仍是纯 Node；peer 到 profile 里其他插件的请求不接 ②，沿 R 的真实祖先链找不到就报错；开发模式下每次路由读一次插件 manifest；同一逻辑路径换 link 目标仍需重启；不经过 hook 的消费者，即插件自己 spawn 的子进程、第三方 Worker、在 profile 目录里运行的外部工具，不再能通过 `$DSH_HOME/profiles/node_modules` 的磁盘链接找到本体包；resolver 继续依赖受支持的 Node Internal 接口。
