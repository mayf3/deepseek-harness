# Agent Note: 保留缓存的 fork child 保持 one-shot

Status: implemented

[English](2026-08-10-fork-children-stay-one-shot.md) | 中文

## 问题

fork 与 spawn 的唯一区别是 child 的 Session 会以 parent 已完成轮次的前缀作为初始内容（见 [subagent-fork-in-process](../../../../packages/subagent/subagent-fork-in-process/README.zh.md)）。这份初始内容有实打实的 token 成本——继承的历史会在 child 的每次请求中重新发送——而它唯一确定的回报是提供方侧的前缀复用：在提供方与模型相同的前提下，起始字节与 parent 逐字节相同的 child 请求，无需为这段共享区间重新预填充。任何由 child 作用域添加在继承历史*之前*的内容都会消耗掉这份回报，因为复用在第一个不同字节处即告停止。

作用域局部的 `report` 返回通道现在是此类添加中最大的一项，而自[report 义务](../feature/2026-08-06-continuable-child-report-obligation.zh.md)起它是两项而非一项增量：`report` 工具 schema，以及 `tool:report` 系统提示词 section。两者都位于请求头部——系统块与工具块先于所有消息——因此一个可继续的 fork child 会在第一条继承轮次之前就使复用失效，并重新预填充它当初 fork 就是为了复用的整份 transcript（文本记录）。这种组合付出了 fork 的复制成本却收不到它的收益，而 parent 手上仍握着一份 child 本可共享的可复用前缀。

## 决策

保留缓存的组合会把 fork 委派工具绑定为 `backgroundMode: one-shot`：[base 组合包](../../../../packages/bundle/base/cordis.patch.yml)、[ACP 示例](../../../../examples/acp-agent/cordis.yml)与[headless 示例](../../../../examples/headless-agent/cordis.yml)。base 组合包保留 `run_in_background`，因为它挂载了 task 服务；两个示例设置 `enableRunInBackground: false`，因为它们都不挂载 task 服务，否则一次 one-shot 后台启动会在调用时因缺少 `tasks` 服务而失败。standard、code 与 Cordis CLI preset 则把 fork 绑定为 `continuable`；其子级作用域的 `report` 增量会使继承前缀失效，并接受这里说明的重算成本。

one-shot child——前台与后台皆然——经由 `SubagentRuntime.start()` 创建，该路径从不进入可继续的 activation setup 注册表，因此 `report` 与它的提示词 section 都不会被安装。于是一个 fork 出的 one-shot child 的系统提示词与工具 schema 与其 parent 相同，只差部署逐个委派工具主动选择的 `persona` 与 `toolFilter` 增量。

`spawn` 保持 `backgroundMode: continuable`。对于 child 起步时本就没有继承前缀需要保护的那个提供方，可继续 child 与 report 义务随附行为不变，因此本决策没有让 report 通道付出任何代价。

### 该限制在于组合，不在于代码

`ForkInProcessProvider.prepareContinuable` 仍然实现完好，`ctx.subagents.startContinuable()` 也接受 `fork`；组合会选择 fork 工具采用 one-shot 还是 continuable。`tool-subagent` 在挂载时同时知道提供方的 `inheritsParentContext` 与自身的 `backgroundMode`，因此一个加载期拒绝该组合的检查是可行的，而这里刻意不加：该组合并非普遍错误。只有在某个 child 作用域增量位于继承历史之前时，它才会产生高昂成本，而产生该增量的包——[`dsh-tool-subagent-report`](../../../../packages/subagent/tool-subagent-report/README.zh.md)——是独立安装的，并且按其自身设计对 `tool-subagent` 不可见。一个不安装 report 包的部署可以在前缀完好的前提下运行可继续的 fork child。把某一份插件清单的后果写成委派工具的不变量，会让该工具断言它无法观察到的事实。

保留缓存的条件记录为 `prepareContinuable` 方法上的 `TODO(fork-continuable-prefix-reuse)` 标记，并由 issue #2124 跟踪：当 child 的系统提示词与工具 schema 能与其 parent 逐字节一致时，可继续 fork 就能保留继承前缀。

## 备选方案

**在挂载时拒绝 `inheritsParentContext` 与 `continuable` 的组合。** 一次响亮的加载期失败可以阻止悄然的重新引入，而配置改动做不到这一点。否决的原因是委派工具看不到 report 包，且在没有它时该组合是合法的；对于从不安装任何 child 作用域增量的部署，这个不变量是假的，而 `tool-subagent` 会去断言一件由插件清单拥有的事实。

**干脆不挂载 fork 提供方。** 这是该限制更彻底的形式。否决的原因是前台 fork *正是*复用前缀的那种情形，且不受 report 通道影响，因此全面禁用会在不换来任何 one-shot 绑定尚未换来的东西的同时放弃该能力——并且随附组合将没有任何一个演练 session 初始内容。

**在保留缓存的组合中随附可继续的 fork child 并接受这份损失。** base 组合包与 ACP/headless 示例不采用，因为这份损失是全额而非边际的：复用在继承历史之前就已中断，于是 child 为一份自己复制过来、目的恰恰是不必付费的 transcript 付了全额预填充。CLI preset 选择了另一项取舍并保留可继续 fork。想要一个没有继承上下文的长期 child 的部署，本来就有 `spawn`。

**让 `report` 对每个 Agent 可见。** 全局注册会通过让 parent 与 child 拥有相同的 schema 与 section 来恢复逐字节相同的前缀。否决的原因是根 agent、one-shot child、远端 child 与无 agent 调用方都会宣告一件推导不出收件方的工具，而执行期拒绝会让 schema 可见性与权限彼此矛盾——这正是[report 工具 Agent Note](../feature/2026-07-30-continuable-subagent-report-tool.zh.md)已经定下的作用域局部决策。

**把 child 作用域增量安装到继承历史之后。** 否决的原因是它无法表达：在每个提供方的协议格式中，系统提示词与工具 schema 都是请求头部结构，因此它们内部的任何排序都无法把仅属于 child 的添加放到消息列表之后。

## 后果

- base 组合包与 ACP/headless 示例只创建 one-shot fork child；其中的 `subagent_fork` 会把结果返回给调用方的轮次，`send_message` 也只寻址 spawn 出的 child。三个 CLI preset 会创建可继续的 fork child。
- 除非部署在 fork 委派工具上配置了 `persona`、`toolFilter` 或不同的 LLM 路由，one-shot fork child 的请求前缀会与其 parent 逐字节相同，因此初始内容的 token 成本可以换来提供方侧的复用。可继续 fork 会在继承历史之前增加 `report`，从而失去该复用。
- fork 提供方的可继续路径有 CLI 生产调用方与包内测试。同一条 seam 也接受 one-shot 组合，因此某个组合包或 `--patch` 覆盖层可以无需改动代码、也不会有任何警告地选择任一生命周期。
- `subagent_fork` 面向模型的 schema 发生变化：base 组合包中可继续的后台措辞被 one-shot 的 task 措辞取代，在两个示例中则完全消失。受影响的无密钥快照工具 schema 伴随文件在同一次改动中重新记录。
- 在每个可继续组合中，report 义务都会覆盖 spawn 出的 child；在 CLI preset 中，它也覆盖 fork 出的 child。它的 `next-step` 默认调度、权限模型与覆盖仍独立于 fork 组合。

### 已接受的风险

one-shot 限制存在于三个配置文件与一处代码注释中，而不在门禁里；CLI preset 行已经选择 `backgroundMode: continuable` 并承担前缀损失。任何组合包或 profile 补丁都能选择任一方式，且不会收到警告。这就是不把某一份插件清单的后果写入 `tool-subagent` 所接受的代价。
