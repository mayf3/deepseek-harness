# Agent Note: 客户端构建期依赖不进安装面

Status: proposed

[English](2026-08-14-client-build-time-deps.md) | 中文

## Problem

浏览器产物不在用户机上解析任何 specifier：

- `ui-*` 插件包的浏览器产物是 `lib/client.js`，tsdown 把每个非平台 specifier 直接内联（`packages/client/tsdown.client.ts` 的 `noExternal`）。留下来的 specifier 由 loader 的冻结模块表应答——那个 bundle 里的 `require` 是 loader 注入的形参，不是 Node 的。
- 平台模块（`PLATFORM_MODULES`）由 shell `dist` 提供，不走 Node 解析。
- shell 自身的 import 由 Vite 内联进 `@deepseek-ai/dsh-web-frontend` 已发布的 `dist`；该包只发 `dist`，连 `.` 导出都没有。

所以浏览器的每条代码路径都是构建产物，或作为静态资源下发，或烤进 `dist`。但这些产物的构建输入——react、react-dom、shiki、katex、clsx、micromark 与 mdast 全族——现在写在 `dependencies` 和非 optional `peerDependencies` 里，而 npm 对每个消费者都会安装这两个区段。全仓 38 个包共 79 处这样的外部依赖声明，装给了永远不会加载它们的用户。

## Proposal

### 规则

**只被浏览器产物触及的外部包落 `devDependencies`。** 两条留白同样是规则的一部分：

- **只管外部依赖**。`@deepseek-ai/*` 一律留在原处：那些声明还表达「谁提供我注入的服务」「这个 assembly 挂载了谁的 Remote」「哪个 Loader 行必须能解析」，[verify-runtime-closure](../../../../scripts/verify-runtime-closure.ts) 与 Loader 都读它，而 app 无论如何都会装那个包——移走只是删掉语义，并没有减少下载。
- **node 面触及的一律不动**，包括被擦除的类型引用。

face 从 manifest 真正发布的入口走图，不用目录规则，所以 `src/` 下只被浏览器入口触及的模块就算浏览器代码：

| kind | 判据 | host face 入口 |
| --- | --- | --- |
| `bundle-half` | 有 `./client` 导出 | 除 `./client` 外的每个导出目标 |
| `browser-library` | `packages/client/` 下且无 `./client` 导出 | 只有 `src/invariant.ts`——宿主唯一能挂载的伴生模块；`.` 面是浏览器代码 |
| `prebuilt-dist` | 无 `.` 导出、发布 `dist` | 没有：这个包不给 Node 提供任何入口 |

### 门禁：`scripts/verify-client-runtime-deps.ts`

接入 `pnpm run hygiene`，约 35 秒——两个绑定 Program 的开销，与同 lane 的 `verify-optional-dependency-imports` 同量级。复用仓内既有工具而不自造一套：`TypeScriptProject`（`scripts/ts-project.ts`）分别绑定 host 与 client 两个编译面（该文件写明两者不能合进一个 program——cordis Context merge 会撞），相对 specifier 交给 `ts.resolveModuleName` 解析，遍历到包边界即停。

判据要害有三条，都是起手那版扫字符串字面量踩出来的：

1. 包名必须按名匹配：`'@deepseek-ai/dsh-client-web-react'` 里的 `react` 子串会静默吞掉 react。
2. `./client` 是不是 tsdown 浏览器 bundle，看的是**产物路径**（`./lib/client.js`）而不是子路径名——`dsh-goal` 的 `./client` 是 `./lib/types/client.js`，一个 tsc 直出的浏览器共享模块。
3. `require`、`require.resolve`、动态 `import()` 的字面量实参都能触及一个包；`require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')` 就是真实存在的宿主解析路径。

两类判定，逐条报告：

| 类 | 数量 | 判据 |
| --- | --- | --- |
| `browser` | 74 | 只有浏览器产物触及 |
| `nothing` | 5 | 没有任何引用具名它：`client-runtime` 的 `react`（与它自己「零 React 引用」的分层红线矛盾）、`ui-settings` 与 `ui-theme` 的 peer `react`、`ui-trajectory` 的 peer `react-dom`、`ui-primitives` 的 `@types/mdast` |

下面每条保守规则都对应一次实测到的误报或语义损失：

- **node 面的类型引用保留声明。** `src/invariant.ts` 里的 `import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'` 运行期被擦除，但它声明了谁提供这个伴生插件要注册的服务——归 `verify-runtime-closure` 管的关系。
- **发布了没有源码对应文件的 Node 入口的包整包跳过，并在输出里点名。** `dsh-goal` 的 `./typert -> ./lib/typert.host.js` 由 typert 生成器直出，自带 `import { z } from 'zod'`，没有任何源码陈述这件事。把这条判据修对，消掉了四处误报，其中包括 `api-gateway` 的 `typert-registry`。
- 包自带的 `cordis*.yml` 算 host face：Loader 行是具名它的插件而不是 import 它。
- `@deepseek-ai/cordis` 豁免——check-workspace-constraints 要求它在每个包里同时是 peer 和 dev。

`--json` 输出供批量改写与安装体积实测复用。

### 安装面少掉什么

对已发布 CLI 真装一遍实测，tarball 字节从独立 cache 读出：103 个外部 tarball 不再下载，合计 6.05 MB。

| 组 | 包数 | 省 |
| --- | --- | --- |
| 语法高亮与数学（shiki 族、oniguruma 族、katex） | 16 | 3.93 MB |
| react 与视图库（react、react-dom、scheduler、immer、zustand、`@tanstack/*`、clsx、use-sync-external-store） | 11 | 1.47 MB |
| markdown 与 ansi 管线及零碎（micromark、mdast、hast 全族、anser、若干 `@types/*`） | 76 | 0.65 MB |

我们自己的 6 个浏览器库包（ui-primitives、ui-slots、web-react、ui-attachment、schema-form、client-web，合计 0.20 MB）仍留在安装面：代码确实具名它们，上面的规则不动那些声明。

### 分刀落地

1. **文档住顶刀**：`packages/client/AGENTS.md` 的依赖声明节，加新插件包 checklist 里的一句。
2. **门禁**：`scripts/verify-client-runtime-deps.ts`、它的 `package.json` 脚本、它在 `hygiene` 里的位置，以及一条反例 spec。
3. **manifest**：38 个包 79 处。其中 50 处需要新增 `devDependencies` 条目，其余包已有同名条目，改动就是删掉一行。
4. **发版后按同一方法复测**，确认这 103 个 tarball 没有回来。

## Alternatives considered

- **扫字符串字面量**：起手就是这么实现的，被上面三条要害否掉——react-in-web-react 的子串已经造成过一次静默漏报。
- **读构建产物（`lib/**/*.js`）而不是源码**：那是 Node 自己的视角，但门禁从此依赖 `pnpm run build`，而且它照样判不了浏览器库包的 `lib/index.js`（platform 是 node、内容是浏览器代码），face 判据两种走法都得有。
- **用 checker 判绑定是否用在值位置**（`verify-optional-dependency-imports` 就是这么做的）：试过，它把 83 处 node 面纯类型声明也判成可移出——没省下任何下载，却实打实损失语义，其中 53 处是 `dsh-invariants`。本门禁要知道的是引用是否存在，而不是它是值还是类型。
- **顺带把我们自己的 6 个浏览器库包也清出安装面**，判据是任何安装都不加载它们：再省 0.20 MB，代价是删掉 74 处代码确实具名的 workspace 声明。已否（2026-08-14）：代码用到的就保留。更干净的终态是这 6 个包不再发布，那是另一个提案。
- **用 `peerDependenciesMeta.optional` 而不是 `devDependencies`**：npm 确实会跳过 optional peer，但那个语义是「消费者可以自行提供」，而这里根本没有运行期消费者。仓内必须装一份才能构建，这正是 `devDependencies` 的意思。
- **交给 knip**：不属于 knip 的范畴，它报的是「声明了但没人 import」。这些 specifier 确实被 import，只是被打包器内联了。实证就是它们在 master 上长期存在而 knip 全绿。只有 `nothing` 那 5 条与它重叠。
- **用 `optionalDependencies`**：语义错，它说的是「装不上就跳过」。

## Acceptance criteria

- `pnpm run hygiene` 包含 `verify-client-runtime-deps` 并通过；一条反例 spec 证明一处 `dependencies.react` 会被拒。
- `pnpm run build`、`pnpm run test:gui`、`DSH_SNAPSHOT=replay pnpm run test:web` 通过——这次迁移不改任何构建输入，产物应逐字节等价。
- 发版后真装一遍，上面那 103 个 tarball 不再被下载。

## Risks

- **留在安装面的 6 个浏览器库包会带着解析不了的 bare import**：`ui-primitives/lib/index.js` 是 rolldown 产物，仍写着 `from "anser"`，而 anser 已经只在 dev。它是惰性的——只有我们的 Vite 构建会读这个文件，用户机上没有任何加载者（已实证：只有浏览器代码 import 它们，宿主从不）。要彻底消掉就让这些包不再发布，见 Alternatives。
- **`@types/*` 报不出来**：源码从不具名它们，规则看不见。`@types/mdast` 被抓到只是因为恰好也没有任何引用。它们本来就该在 dev，补这个缺口是后续的事。
- **被跳过的包没人管**：`dsh-goal` 因生成入口整包跳过，它浏览器侧的声明现在没有门禁看着。能读到生成产物自身的运行期 import，这条豁免才能收回。
- **误报会删掉运行期真需要的声明**：三层兜底守住这条线——`require`、`require.resolve`、动态 `import()` 的字面量实参都算引用；包自带的 `cordis*.yml` 算 host face；`@deepseek-ai/*` 整体不在判据范围内。
