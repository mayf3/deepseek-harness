# Agent Note：fail-loud 只在启动期，包在子进程里探测

Status: implemented

[English](2026-09-04-boot-scoped-fail-loud-and-package-probe.md) | 中文

## 问题

`installFailLoud` 注册了一个进程级的 `unhandledRejection` 处理器，写出 `fatal load failure` 后退出，而 launcher 丢弃了它返回的卸载函数，于是这个处理器活到进程结束。启动期间这是对的：未处理的 rejection 就是没人会报告的加载失败。启动之后它意味着任何插件的漏网延续——社区组合包忘了 await 的一个被拒 promise——都会把每个会话一起拖下去，而且根本没有 `uncaughtException` 处理器，定时器回调里的一次同步 throw 会让进程带着 Node 的默认堆栈崩掉，没有来源。插件管理器存在的目的正是在运行时挂载三方代码，在这两个默认行为之下这是拿进程赌。

另外，不把包 import 进宿主就没法知道一个已安装的包是什么：它是声明了组合包层还是导出了插件，它的 patch 会插入哪些行，它把 `@deepseek-ai/cordis` 解析到 harness 的那份还是自己的一份——在 profile 的 hoisted linker 与 `autoInstallPeers: false` 之下这才是"依赖冲突"的真实形态——以及它的主导出带什么 `Config` schema。

## 决定

**fail-loud 在树起来时结束。** launcher 保留 `installFailLoud` 的卸载函数，在 `boot()` 返回后调用它，然后安装 `installRuntimeGuards`：启动后未处理的 rejection 以"已兜住"报告到 stderr，进程继续运行；未捕获的异常连同来源一起报告，进程退出，如 Node 所做，因为其状态未知。两个处理器在关闭时移除。

**嵌套失败被报告，暂不致命。** `warnNestedFiberFailures` 遍历每个 runtime 的 fiber，报告属于内置条目却不是该条目根 fiber 的 `FAILED` fiber——抛错的 `ctx.inject()` 延续，Loader 给它盖了条目的章，而激活审计从未看见它。它在启动后以提示行运行；确认随附组合没有这类失败后再并入致命审计。

**探针在伤不到宿主的地方运行包。** `probePackage` 在宿主里读取已安装包的 manifest——从 `dsh.bundle` 得到种类、其 patch 的行与覆盖、`dsh.plugins` 声明、`engines.dsh`、标题与描述——并生成一个 Node 子进程——`probe-child.ts`，探针旁边的独立模块，源码启动时经 tsx 运行，构建后是 `lib/probe-child.js`——从该包解析 `@deepseek-ai/cordis`，import 主导出与每个声明为可添加的模块，经 IPC 通道发出一份报告。stdout 与 stderr 仍归被 import 的模块自己，所以在 import 时打印的包照样能报告；报告一到子进程就被杀掉，因此让定时器一直活着的包不再多花任何代价。报告与缓存记录按各自跨越的进程边界与文件边界逐字段校验：无法识别的报告是一次 rejection，无法识别的记录重新探测。抛错、退出或挂起的子进程得到带原因的 `ok: false`，或点名超时的 rejection；`ok` 只表示主导出 import 成功且 cordis 不是第二份副本，能否启用或添加由 `kind` 与 `addable[].ok` 决定。记录缓存在 profile 的 `.dsh-plugins/` 下，按版本失效。

## 考虑过的替代方案

**把运行时 rejection 归属到产生它的插件并把该插件标为失败。** 正确的终态，但 promise 不携带 fiber，cordis 的 effect 包装也只覆盖插件经由它注册的东西。延后：守卫现在只报告并兜住；归属需要一个 async-context seam。

**在宿主里 import 包来了解其形态。** 否决：import 会在用户启用任何东西之前以宿主权限运行代码，包的模块作用域里的一次挂起或 `process.exit` 就是宿主的。

**保持 `installFailLoud` 进程级并要求插件作者小心。** 否决：harness 无法审查它允许用户安装的代码，而漏掉一个 `await` 的代价是每个会话。

## 后果

启动后任何插件的漏网 rejection 是一行 stderr 而不是退出；行为不当的包在启用前就由其探针记录诊断出来。探针每次安装及每次版本变化增加一个子进程，默认上限 20 秒。把运行时 rejection 归属到插件仍是开放问题，因此插件列表暂时不能标出报告的 rejection 来自哪个插件。

## 测试

`packages/boot/app-boot/tests/contained-group.spec.ts` 在伪进程上钉住 `installRuntimeGuards`（rejection 报告不退出、异常退出、卸载），也对真实进程验证；并在启动后的树上钉住 `warnNestedFiberFailures`：内置条目下与受控条目下各有一个抛错的 `ctx.inject()` 延续。`tests/probe.spec.ts` 在临时 profile 下布置包：带门控行、匿名行、嵌套行与一条覆盖的组合包，普通插件，库，import 时抛错的包，自带 cordis 副本的包，可添加模块缺失的包，挂起的子进程，退出的子进程，不可解析的包，以及错误的 Node 可执行文件；还有缓存往返、版本不匹配与损坏记录。
