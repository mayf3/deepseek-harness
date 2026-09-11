---
description: "dsh profile 与临时 Python SDK 运行时的共享 Loader 启动支持：环境层、patch、诊断与配置预览。"
kind: "package-library"
---

# @deepseek-ai/dsh-app-boot

[English](README.md) | 中文

## 概述

`dsh-app-boot` 是 `dsh` profile（包括 Python 运行时 wheel 包所含的 CLI（命令行界面））背后的共享 Loader 启动库。它加载环境层、组合 profile 组合包与 patch、启动每个插件，再返回运行中的应用，或指出失败插件与原因。产品应用使用 `dsh` launcher 而不发布单独 bin；直接配置 helper 只保留给低层嵌入方与测试。你还可以在启动前预览生效配置，按 profile 选择实时或仅启动时应用 patch，并让持有终端的应用在致命退出前恢复终端。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用此包启动应用是一个小而显式的入口：你给它一个配置文件，它运行整个启动过程。本节说明你能做什么、能得到什么；每个结果背后的 helper 调用记录在下方可折叠的实现章节中。

### 何时使用

在实现共享 `dsh` launcher 或嵌入其低层启动 helper 时使用它。产品功能应放入 profile 组合包，而不是新增应用 bin；只向已运行应用添加插件的代码直接挂载插件即可。

### 启动应用

你把配置文件交给入口，进程就会启动整个应用：加载环境层、应用 patch 与 profile、启动每个插件，并在应用运行后返回。在回放模式下，它会启动同级的 `cordis.snapshot.yml` 替代文件，使已记录的会话能够原样复现。最小的入口只需两次调用：

```text
installFailLoud('dsh')
const ctx = await boot('dsh', resolveConfigPath(argv[2], process.env.DSH_SNAPSHOT))
```

启动审查使用[全局必需条目 id](../../../.agents/notes/implemented/architecture/2026-09-09-consumer-owned-startup-strictness.zh.md)，另按条目身份将启动 Include 视为必需。已存在且启用的必需条目必须激活；缺失和禁用的 id 不影响启动。其余条目失败只产生警告并保留成功的兄弟条目，包括内置工具、用户 patch 行，以及没有 profile runtime 的直接 `boot()` 调用。

<a id="profiles"></a>
### Profile

Profile 与组合包的声明类型从 [`@deepseek-ai/dsh-package-manifest`](../../util/package-manifest/README.zh.md) 导入。App-boot 将 `DshPackageManifest` 适配为包身份可选的 `ProfileManifest`，因为本地 profile 无需发布版本。App-boot 负责 profile 加载、JSON 校验和解析后的运行时数据。

profile 是同一套 dsh 安装提供不同应用界面的方式：`web`、`headless`、`acp`、`sdk` 与 `sdk-minimal` 从同一 launcher 启动不同组合。profile 位于 `$DSH_HOME/profiles/<name>`，由可安装组合包、自身 `cordis.patch.yml` 与 `patchReload: live | startup` 组成；自定义 profile 省略 reload 策略时保留历史 `live` 默认值。随产品交付的 `web` 模板实时重载，其他随附模板只在启动时应用 patch。`sdk-minimal` 只列出自身的独立组合包，其他模板保留 base 加模式的组合包栈。`dsh --profile <name> --from-default-profile <template>` 从一个随附模板，在新的非内置名称处创建自定义 profile；`dsh plugin` 则初始化以 base 为基础的 profile，并管理其中安装的组合包。缺失组合包或未声明 patch 的组合包会让启动明确失败。由应用持有的 npm 项目（例如 Electron 保留的 Desktop profile）通过 `loadProfileDirectory` 加载已经初始化的目录，而不会将它暴露给 CLI profile 查找。

你的机器本地偏好同样位于 harness home 中：

- **`.env`**——你的普通环境层：调用目录的文件优先于 harness home 的文件，两者都低于继承环境。在文件中设置的进程启动变量（如 `PATH`、`DSH_*`、`XDG_*`）会被拒绝：请改为导出这些变量。四个代理名（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`）只从 harness home 的文件接受，绝不从调用目录的文件接受——后者随 clone 一起到来。对于只想加载某个目录 `.env` 的非产品 bin，文件缺失不影响启动，文件无法加载时输出一行带标签的警告。
- **`cordis.patch.yml`**——你的 tweak 层，应用在所有组合包层之后（先应用逐 profile 的文件，再应用 home 级文件，因此后者优先级更高）：替换某个条目的整个配置（重述你要保留的字段）、插入新条目，或在启动时插值 `!!js` 表达式。patch 指定的条目不存在时输出 stderr 警告；空文件或仅含注释的文件会导致启动失败——如需禁用该层，请改用 `[]`。

带 `patchReload: live` 的 profile 会监视两份用户 patch 文件，并应用[重载失败策略](#startup-and-reload-failures)。`startup` profile 既不安装这些监视器，也不安装 launcher 的仅监视 HMR（热模块替换）回退。

插入条目的插件名可以是绝对文件系统路径、文件 URL 或包标识符。patch 加载会把 `insert` 条目及其嵌套分组中的绝对路径以及相对于 patch 文件的 `./` 或 `../` 路径转换为文件 URL；对已有条目名称的断言及替换用的 `config` 值保持原样。

组合包 patch 保留声明的 id、父组和顺序。各层按 manifest 顺序占有行 id；组合包重复声明或使用已占用的 id 时整层被排除并报告，冲突的用户插入则逐行排除。`dependencies` 记录安装；`dsh.profile.bundles` 选择启用的层，包括它们的全部插入和覆盖。包元数据不决定启动严格程度。

launcher 在任何配置行挂载前提供 `ctx.profileRuntime`。该运行时要求注入 Loader，支持从根上下文和插件上下文取得的句柄调用。它拥有行来源、已接受的组合、冲突和用户禁用行信息。文件监听与管理操作共用它的串行重组队列。重组等待当前条目和已移除 fiber 完成后，发布已接受的选项并报告逐行问题；更新失败时，fiber 可能仍使用先前的有效配置运行。`installFailLoud` 保持到应用关闭，处理进程级未处理 rejection。 观测方可等待 `whenIdle()` 后，再发布包含组合归属的刷新视图。

<a id="patch-files"></a>
### 补丁文件

上面的每一层都是一个 `cordis.patch.yml`：一个顶层 YAML 序列，元素是 include 插件的 `PatchOptions`——按 id 定位的覆盖与 `insert` 列表——采用 Loader 的方言，其中 `!!js` 标记一个由该行 fiber 求值的表达式。`./patch-file` 导出是读写这种文件的唯一地方，因此启动接受的文件就是 agent preset roster 与插件管理器接受的文件。

用 `parsePatchList`（已有文本）或 `readPatchListFile`（文件不存在时读到 `undefined`）读取一层。两者都把 `insert` 行中相对的名字（如 `./plugin.js`）锚定到文件自己的目录，并对任何不是"映射序列"的内容直接报错，因为一个完全无法施加的补丁文件就是配置错误；而目标行不存在的单条补丁仍然只是 Loader 的逐条警告。

通过 `mutatePatchFile` 写入。回调拿到一个 `PatchDocument`，按 Loader 寻址行的方式以行 id 编辑：

```ts
import { mutatePatchFile } from '@deepseek-ai/dsh-app-boot/patch-file'

const file = '/home/me/.dsh/profiles/web/cordis.patch.yml'
await mutatePatchFile(file, (document) => {
  document.setRowField('tool-web', 'disabled', true)      // the id-targeted patch is created when absent
  document.deleteRowField('tool-web', 'config')           // a patch reduced to its id is removed whole
  document.appendInsert({ id: 'tool-foo', name: 'dsh-tool-foo' })          // into the root list
  document.appendInsert({ id: 'sql', name: 'dsh-sql' }, 'agents')          // into the group with that id
  document.removeInsert('tool-foo')                       // an emptied insert patch is removed whole
}, { binName: 'dsh', mode: 0o600, dirMode: 0o700 })
```

`setRowField` 永远不接受 `id` 与 `insert`；`rowField` 读回一个键，`!!js` 标量以其源文本返回。`appendInsert` 拒绝文件已插入的 id；`insertedRow`/`removeInsert` 也能找到插入组内部的行。写入的值都是普通数据；别的键上的 `!!js` 标量原样不动，这正是用户层能撤回自己写的 `disabled: true` 而不惊动组合包在另一行上的 `!!js` 门的原因。

`mutatePatchFile` 像 `dsh-atomic-write` 一样占用 `<file>.lock` 兄弟文件，读取文件（不存在按空处理），施加编辑，在文本有变化时以声明的权限位原子替换文件，然后返回从写入文本重新读出的补丁列表。什么都没改的编辑什么都不写。

### 预览生效配置

启动前，你可以打印应用将挂载的确切配置：dump 会以 `!!js` 表达式原样展示组合后的条目列表，并按注释分组标明每个源文件及其 patch 层，输出是一份可加载的 YAML 文档。未匹配到任何行的 patch 会连同其层标签一起报告；配置缺失、无法解析或字段无效都会使 dump 失败。

<a id="startup-and-reload-failures"></a>
### 启动与重载失败

Loader 结算后，app-boot 将 optional 失败报告为警告；若已启用的 required 条目无法激活，则拒绝启动。表中的“终止启动”指释放已挂载插件并以非零码退出，不报告就绪；“继续”指保留成功运行的插件。后续配置 HMR 不会再次执行 required 启动审计，也不会回滚整个更新。

| 失败模式 | Optional 条目启动时 | Required 条目启动时 | 后续配置 HMR |
|---|---|---|---|
| 根配置或必需 overlay 缺失、不可读、格式错误，或包含无效条目 | 终止启动 | 终止启动 | 拒绝格式错误或无效的实时 patch，不改变运行中的配置；有效修改可以应用 |
| 模块 import 失败或模块求值抛出异常 | 警告；继续 | 终止启动 | 报告错误；保留成功的兄弟插件；修正 import 后可以激活 |
| 插件配置 schema 校验失败 | 警告；继续 | 终止启动 | 新条目保持未激活；现有条目保留原实例与配置；有效修正可以应用 |
| 配置 `!!js` 求值抛出异常 | 警告；继续 | 终止启动 | 报告错误；保留成功的兄弟插件；有效修正后可以激活 |
| `disabled: !!js` 求值抛出异常 | 警告；继续 | 终止启动 | 报告求值错误，不将条目当作已禁用；有效修正后可以激活 |
| 同步 `apply()` throw | 警告；继续 | 终止启动 | 报告错误；保留成功的兄弟插件；修正配置后可以激活 |
| 异步 `apply()` throw | 结算后警告；继续 | 结算后终止启动 | 结算后报告错误；保留成功的兄弟插件；修正配置后可以激活 |
| 注入的服务不可用 | 警告；继续，条目等待依赖 | 终止启动 | 条目继续等待；补上缺失的提供方后可以激活 |
| HTTP 端口绑定失败 | 警告；继续，但该端点不可用 | 终止启动 | 进程继续运行，但失败的端点不可用；修正配置后可以恢复 |
| 脱离 `apply()` 返回 Promise 的异步任务产生未处理 rejection | 致命错误：释放应用并以非零码退出 | 致命错误：释放应用并以非零码退出 | 致命错误：释放应用并以非零码退出，与条目 id 无关 |
| 条目缺失或被显式禁用 | 忽略 | 忽略 | 不激活该条目；不执行 required 启动审计 |

可选提供方失败可能使必需消费方等待依赖，从而阻止应用就绪。覆盖已有行不会改变其所有者或启动策略。已有行在更新前校验失败，不会回滚其他行已成功的变化。

[Web 进程矩阵](../../../apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts)和[启动验收测试](../../../apps/cli/tests/profiles/web/tests/web-best-effort-startup.expected.e2e.ts)通过随附 Web profile 验证这些结果；[app-boot 测试](tests/app-boot.spec.ts)还覆盖根 Include 失败。

如果你的应用持有终端，它可以在进程退出前把终端交还，你的 shell 绝不会残留在 raw 模式。交还过程有界：卡住的清理只会延迟致命退出，而不会取消它。

### 告诉 agent（智能体）harness 所在位置

当你的应用启动模型驱动的 agent 时，你可以告诉 agent DSH 实现代码 checkout 的位置：它得知该路径，也知道不得据此推断工作目录——它应使用 `pwd`。这条指示在系统提示词靠前位置出现一次。没有系统提示词服务的应用会跳过；开发环境中，重新加载系统提示词后它会消失，直至下次启动。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释上述结果如何实现，并指出实现它们的代码位置；这里的内容面向开发者，使用本包并不需要。

### 设计说明

- **与渠道无关的库。** 此包不包含 loader 钩子，也不提供开发模式接口；[`dsh` 应用](../../../apps/cli/README.zh.md) 持有自己的 Node 源码启动钩子，并在启动序列中使用这些 helper，构建后的消费方则使用普通 Node 包解析。
- **两个 Loader builtin。** `mountRootInclude` 把 `cordis:include` 与 `cordis:group` 注册为 Loader builtin：group 行能把一个提供方与它的消费方放进同一个 `isolate` realm，而位于本工作区之外的 agent preset 无法按名称解析 `@deepseek-ai/cordis-plugin-group`。两者都通过宿主的模块管线加载，而非被包含树自身的说明符解析。
- **消费方决定严格程度。** 普通 Loader 组保留成功的其他行。app-boot 在启动完成后按必需条目 id 审计；agent preset 拥有并清理要求全部配置行激活的代际。行失败从 Loader 与 Fiber 读取，重复的 rejection 通知在一个进程检查点内合并。
- **Profile 模块后备机制。** 裸插件 specifier 由 Loader 从配置目录解析。普通 Node 会为安装依赖闭包中的每个包维护一个符号链接。打包可执行文件无法让操作系统符号链接进入 pkg 的 `/snapshot` 树，因此会按 Node ESM 条件读取已安装包的 export map，并写入重新导出虚拟模块 URL 的真实代理包。缺失 export 保持不可用，错误 export map 会让启动失败，跨进程 writer lock 则会在不暴露部分代理的情况下替换陈旧条目。所选外部组合包若不在安装闭包中，则会获得 profile 本地的 `.dsh-module-fallback` 链接；已有 pnpm 条目优先，后续闭包发现会排除投影链接，清理也只删除 dsh 自有链接。
- **更新完成。** 实时重载等待 Loader 工作后检查逐行问题。profile 重组还等待已移除 fiber 的清理，这些工作已不在当前 Loader 树中。单独完成 `Fiber.update()` 和 `Entry.update()` 不代表重启成功。
- **两阶段失败标签。** `boot()` 区分 `host preparation failed`（`prepare` 在任何配置树条目挂载前抛出）与 `plugin tree failed to load`。插件诊断包含原始堆栈、嵌套原因和聚合错误中的各项失败。原因链出现循环时，诊断遍历会终止，不会替换原始原因。

### Helper 行为

每个导出各负责启动的一个阶段：配置解析与快照回放、分层环境加载、明确报错的保护机制、激活审计、patch 解析、根 include 挂载、配置 dump 渲染、活动 patch 监视、profile 组合，以及 harness 源码段落。各导出的约定在代码中，不在本 README——见 [`src/index.ts`](src/index.ts) 与 [`src/profile.ts`](src/profile.ts)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 启动、环境层、fail-loud 处理、启动审计、patch 解析与监听、配置导出 |
| [`src/profile.ts`](src/profile.ts) | profile 发现、初始化、组合包解析、模块后备机制 |
| [`src/external-bundles.ts`](src/external-bundles.ts) | 组合包归属分析及安装、启用 manifest 列表 |
| [`src/compose-stack.ts`](src/compose-stack.ts) | 整叠层的行 id 归属：`claimLayerIds`、`composeProfileStack`、冲突记录 |
| [`src/entry-issues.ts`](src/entry-issues.ts) | 当前条目失败、未满足服务和诊断格式化 |
| [`src/profile-runtime.ts`](src/profile-runtime.ts) | `profileRuntime` 服务：已提交的组合（profile、行来源、冲突）、用户停用的行、重新组合 |
| [`src/package-metadata.ts`](src/package-metadata.ts) | 静态 manifest 与 patch 声明；不执行模块，不使用 probe 缓存 |
| [`src/patch-file.ts`](src/patch-file.ts) | 公开 patch 文件解析器与用户层原子编辑器 |
| — | 不发布运行时不变式伴生入口；边界与回放测试覆盖其协议映射。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享启动机制逐步进入组合模型及其背后的决策证据。

- [Cordis 入门](../../../docs/cordis-primer.zh.md)——Loader、`!!js` 配置表达式，以及 include/group 语义。
- [dsh 应用](../../../apps/cli/README.zh.md)——消费这些 helper 的 `dsh` bin。
- [dsh-cmdline](../cmdline/README.zh.md)——各 bin 使用的启动器到应用命令行交接。
- [Profile 组合包](../../bundle/README.zh.md)——组合进 `dsh --profile` 的可安装 patch 层。
- [dsh-home-paths](../../util/home-paths/README.zh.md)——harness home 解析器（`resolveDshHome`）。
- [配置来源归属](../../../.agents/notes/implemented/architecture/2026-08-04-configuration-source-ownership.zh.md)——被发现的文件为何不得决定 bootstrap 行为。
- [Profile 插件组合包](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md)——profile 与组合包组合设计。
- [用户 patch HMR 测试](../../../.agents/notes/implemented/testing/2026-09-09-user-patch-hmr-test-delivery.zh.md)——实时 patch 行为与原生文件系统投递的验证归属。

-----

<a id="model-experience"></a>
## 模型体验

模型通过此包加载的插件树间接受影响——只有该树贡献模型上下文；唯一贡献模型可见文本的导出 `addHarnessSourceSection`，也只有在消费方启动后调用它时才会产生影响。

#### KV Cache 影响

启动本身不改变请求前缀。`addHarnessSourceSection` 将源码路径放在第一方可复用指令之后，因此工具与配置一致时，不同 checkout 不会改变前置字节。不保证提供方复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明此启动库在何时不合适，或何时需要特别注意。它们是当前包约束，不是任务积压。

- **裸包 specifier 依赖 Loader 内部机制**——生产 bin 需要 Loader 的可选原生辅助组件；没有该辅助组件的进程内调用方必须使用可解析的相对／file specifier，或提供自己的模块解析钩子。
- **快照回放替换仅识别特定 basename**——只有以 `cordis.yml` 或 `cordis.yaml` 结尾的配置会映射到同级 `cordis.snapshot.yml`；自定义配置名称需要调用方自行选择。
- **环境发现以启动为界**——`loadLayeredEnv` 只读取一次调用目录与 harness home 中的 `.env`；它不搜索父目录，也不跟随之后选择的 workspace。`loadEnv` 仍是非产品 bin 使用的单目录 helper。
- **用户 patch 会替换匹配到的整个配置**——按 id 定位的 patch 不做深度合并，因此 profile 覆盖必须重述需要保留的组合包字段。
- **覆盖保留目标的所有者**——修改内置行可能使该必需行失败；其他行成功的更新仍然生效。禁用组合包移除其整份 patch 层，包括覆盖。
- **冲突按顺序判定，不看是非**——外部组合包之间，`dsh.profile.bundles` 里靠前的那层保住争议 id，卸掉它之后靠后的那层在下次启动时挂上；插件列表显示谁输给了谁。
- **嵌套 fiber 审计只是提示**——内置条目下失败的 `ctx.inject()` 延续会被报告而非致命，直到确认随附组合都没有这类失败。
- **声明不代表激活结果**——`readPackageMetadata` 读取 `dsh.plugins`，不导入模块。主入口声明为 `plugins: [{ name: "." }]`，子路径可写为 `./tools`；未声明的包保持 `unknown`。Config 校验和执行诊断只在实际挂载后产生。Cordis 物理路径解析无法识别被内联打包的副本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 待定：配置 dump 稳定性

`renderConfigDump` 的输出是一份可加载的 YAML 文档，其 `# ==` 来源注释与 `!!js` 原样渲染服务于 `--dump-config` 诊断。任何内容都不承诺跨包版本的字节稳定性；在程序化消费该输出之前，请决定 dump 是否成为序列化约定。

</details>
