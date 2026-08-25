---
description: "DeepSeek Harness 代码执行 seam 的 CPython 子进程实现，提供 fd-3 binding、资源限制、日志捕获与进程组拆卸。"
kind: "package-reference"
---

# @deepseek-ai/dsh-code-runtime-python

[English](README.md) | 中文

[`@deepseek-ai/dsh-code-runtime`](../code-runtime/README.zh.md) seam 的 CPython 子进程实现。与 [`@deepseek-ai/dsh-code-runtime-worker-thread`](../code-runtime-worker-thread/README.zh.md) 配套；以全新的 `python3` 子进程取代 Node worker 线程，让模型代码从 TypeScript 换成 Python。

本包持有该 seam 的 wire protocol：host 侧的帧编解码，以及 Python 侧对同一套消息词汇的镜像。在该协议之上，本包交付 `PythonCodeRuntime`（插件的默认导出），它以 `language: 'python'`、`isolation: 'process'` 注册为 `codeRuntime`。每次 `run()` 启动一个全新的 `python3 -I` 进程，通过 fd 3 发送 boot 帧和程序，并为每个程序结果 resolve 一个 `CodeRunResult`——`run()` 仅在 seam 被误用时才 reject，例如 binding 命名空间不合法，或对 fiber 已被 dispose 的 runtime 发起调用。配置错误在更早的插件加载期被拒绝：非 Unix 平台、非正或非整数的预算、低于截断标记下限（64）的 `maxLogBytes`、会被 `setTimeout` 截断的定时器值、超过单个 fd-3 帧承载能力的预算，以及最坏峰值会突破 `RLIMIT_AS` 的 `addressSpaceMb`／输出预算组合，都从构造器抛出，因此配置错误在装配时就失败，而不是等到之后某次运行。子进程把程序作为 async 函数体运行，因此顶层 `await` 与 `return` 都可用；binding 调用经 fd 3 以 JSON-lines 回传。containment 不是安全边界——模型代码具有等同 bash 的信任级别；空环境、`RLIMIT_CPU`／`RLIMIT_AS`、墙钟上限与对子进程进程组的 `SIGTERM`→grace→`SIGKILL` 拆卸共同提供 containment。

## Wire protocol

host 与 CPython 子进程在子进程的 fd 3 上交换一个无版本号的 JSON-lines 协议——每行一个 JSON 对象，让 stdout/stderr 空出给程序自己的输出。`src/protocol.ts` 是 host 侧；`py/protocol.py` 在 Python 侧镜像其帧词汇与共享的截断标记文本。

- **fd 3，而非 stdout** —— Node 通过 `stdio: ['pipe','pipe','pipe','pipe']` 按位置钉住通道；Python bootstrap 读取相同的 `PROTOCOL_FD` 常量。JSON-lines 帧。
- **host 把每个入站帧当作敌意输入** —— 模型代码对 fd 3 有完全访问权、可通过它发送任意内容，所以 `validateChildFrame` 在 host 读取前对每个帧做形状校验并重建：伪造的额外字段绝不随行，非数字的 call id 绝不会被回显进 reply，垃圾降为 `undefined` 被丢弃，而不是在 host 的 message handler 里抛错。Python 侧信任 host 回复（host 不受模型控制）。
- **lossless-JSON 穿越** —— 完成值与 binding 参数以精确 JSON 穿越。`encodeJsonPlain` 无递归地序列化一个 `JSON.parse` 产出的值，使低于字节预算的深层值能完整穿越，而不是死在 `JSON.stringify` 的栈限制上；`checkDoneValue` 在一次有界遍历中同时计量伪造完成值的字节长度与数字无损性，在把子节点入栈之前就拒绝超预算 payload；`hasUnsafeIntegerToken` 读取原始帧文本，捕获 `JSON.parse` 会静默舍入的整数 token；`hasNonLosslessNumber` 拒绝无字节上限的 `call.args` 中的非有限数或负零。超出安全范围的整数型 double 通过 `BigInt` 数字序列化，穿越的是精确整数而非 `String()` 的舍入形式。
- **共享截断标记** —— `logTruncationMarker(maxBytes)` 在两侧产出逐字节一致的文本，使被截断的日志运行无论从哪侧触达上限都读起来一致。`log` 帧的 `truncated` 标志把子进程 ledger 自身的标记与程序输出区分开。

## Configuration

每个上限都是带默认值的、经校验的 `Config` 字段，可从 `cordis.yml` 修改（无硬编码可调项）。`cpuSeconds`（默认 60）是 `RLIMIT_CPU` 的整秒预算；子进程把软限设为 `cpuSeconds`、硬限设为 `cpuSeconds + 1`，因此内核在软限处发出的 `SIGXCPU` 被归类为 `timeout`，而 +1 秒的硬限是 `SIGKILL` 兜底。`maxWallMs`（默认 600000）是墙钟上限，为一个在等待无人 resolve 的 promise 的程序兜住 CPU 时间。`addressSpaceMb`（默认 512）是 `RLIMIT_AS` 上限，在 Darwin 上不施加（那里映射进每个进程的 dyld 共享缓存超过任何实际上限；`cpuSeconds` 与 `maxWallMs` 仍约束运行）。`maxLogBytes`（默认 65536）是共享的捕获日志字节预算；`maxValueBytes`（默认 32768）为完成值设上限；`graceMs`（默认 3000）是 `SIGTERM`→`SIGKILL` 的 grace 窗口；`pythonBin`（默认 `python3`）是解释器，在子进程以空环境启动前先对 `PATH` 解析。

## Model Experience

间接触达：经由 [`dsh-tools`](../../core/tools/README.md) 中的 Code Mode——它把本后端精确的完成值（在放得下时）或一个明确的 `invalid-output` ／ `output-limit` 失败，连同精确的 `[dsh-code-runtime-python] log capture truncated at <maxLogBytes> bytes` 日志标记，一并渲染进一条被保留的 `run_code` 结果。

#### KV Cache effect

不直接造成失效；任何对请求前缀的改动由上述具名 Consumer 负责。

## Known Limitations and Deferred Work

- **跨语言 guard 覆盖执行值与帧字段集，但不覆盖字段类型** —— `tests/protocol-mirror.e2e.ts` 使用真实 `python3` 比较 `PROTOCOL_FD`、日志截断标记，以及每个 `TypedDict` 的必填和可选字段。跨 TypeScript 与 Python 比较字段类型在此没有机械等价物，因此类型级漂移由 review 加后端真子进程套件负责。
- **`RLIMIT_AS` 在 macOS 上不施加** —— 在 exec 时映射进每个进程的 dyld 共享缓存超过任何实际的地址空间上限，内核会拒绝该 `setrlimit` 调用，故 `addressSpaceMb` 在那里被跳过。`cpuSeconds` 与 `maxWallMs` 仍约束每一次运行。
- **PID 复用防护在 macOS 上失效** —— `readProcessStart` 读取 `/proc/<pid>/stat`，Darwin 不提供它，因此防止 `killGroup` 对已回收的 pgid 发信号的同一性复检在那里恒通过；`killGroup` 在 macOS 上不经同一性复检直接对 pgid 发信号，而非在拆卸路径上付出一次 `ps` fork。进程组拆卸与 `closeDeadline` 上界仍约束该次运行。
- **C 扩展的 stdio 缓冲在结算时不被排空。** 子进程以 `-u`（无缓冲）运行，因此 `sys.__stdout__`/`sys.__stderr__` 与 `os.write` 的字节立即可见；但 C 扩展私有的 C-stdio（`FILE*`）缓冲在解释器之外，其未写出的字节会在宿主于 done 帧后 SIGTERM 子进程时丢失。模型代码若需保留，应在返回前显式 flush C 层 stdio。

- **原始长度超过 64 MiB 的 fd-3 帧会让本次运行以 worker-exit 结算。** 接收路径在 `toString`/`JSON.parse` 之前把原始帧限制在 `FRAME_PARSE_CAP_BYTES`（紧凑宽帧解码后可能占用远超线上字节的宿主内存）。`maxLogBytes`/`maxValueBytes` 在加载期被限制到该解析器上限，因此诚实子进程的帧总能放得下；模型构造的超过 64 MiB 的 binding 实参（一个在 seam 层没有预算的值）会触发同一上限——这是该 OOM 防护的已接受残余。

- **截断日志的序列化数组会到 `maxLogBytes` 加标记为止。** 截断标记是 envelope 而非 payload——它不计费地随行，因此总能发出——而外层数组外壳在账本中预留了一字节。因此带已放行条目的截断运行，其 `logs` 数组序列化后至多为 `maxLogBytes + marker + 1`；标记单独能放进任何可接受的预算（64 字节下限保证这一点）。
- **调用 `setsid()` ／ `start_new_session=True` 的后代会逃出 teardown。** 终止是用 `kill(-pid)` 向子进程的进程组发信号；一个把自己移入新会话的后代已不在该进程组内，任何信号都到不了它。若它同时释放了继承而来的 stdout／stderr／fd-3 管道，leader 的 `close` 仍会结算该次运行，在 `closeDeadline` 到界之后 fiber 变为完全停稳，而那个孤儿仍在运行。这是 containment 边界，而非安全边界——模型代码具有等同 bash 的信任级别，一个 bash 工具同样能 `setsid` 逃逸。要够到这样的孤儿需要追踪每一个后代 pid（如 bash-local 后端的 process-inspector 所做），此项已推迟；进程组 teardown 会回收所有留在组内的进程。
- **日志与完成值的叠加峰值未被加载门建模。** 每项预算都是各自对照 `addressSpaceMb` 检查的。模型的 daemon 线程可以在完成值被计量并分帧的窗口内持续写入、把日志 pending 重填到接近 `maxLogBytes`，于是两个峰值以任何门都不曾放行也不曾拒绝的方式相加。对 `(maxLogBytes + maxValueBytes)` 设门的方案经评估后推迟：它的判别用例无法在 `RLIMIT_AS` 之下确定性地构造出来，因此该门只能证明自己的算术。叠加峰值被触及时该次运行死为 `worker-exit`——containment 仍然成立，只是失败分类失真。
- **1 秒双限 `ulimit -t 1` 下的 CPU 超限会被报告为 `worker-exit`，而非超时。** 当宿主在一个硬 CPU 限制等于软限制（`ulimit -t N` 同时设置两者）且该限制为 1 的环境下启动时，`_clamped` 无法把软限制降到 0，因此内核在同一 tick 直接 SIGKILL 忙循环，SIGXCPU 永不送达。宿主只在 `signal === 'SIGXCPU'` 时把 CPU 超限分类为超时，因此该超限被报告为 `worker-exit`。当双限为 2 或更大时，软限制会被降低一个单位，SIGXCPU 触发，该次运行成为超时。两种情况 containment 都成立；只是分类被降级。
- **一个 trap SIGXCPU 的程序可以在结算编码期间超过软 CPU 限制并仍报告成功。** 结算时的 CPU 复查（`die_if_cpu_exhausted`）在程序返回后、日志 flush 与完成值编码之前无条件运行；一个在返回前已超过软限制的程序会在这里死于重投递的 SIGXCPU，被归类为超时。唯一的误报窗口是一个通过复查后、trap 住 SIGXCPU 并在结算 flush/编码窗口内越过软限制的程序。不做编码后复查，是因为那会把结算编码自身消耗的 CPU 记到程序头上、误分类一个合法的近限程序。containment 成立——硬限制（软限制 + 1s）与墙钟仍会约束它——只是分类被降级。
- **编码器的直接依赖在调用时解析。** `_encode_json_plain` 通过模块全局查找到达 `_dump_scalar`/`_dump_string`/`json`，因此以 `__main__` 运行的程序在返回合法值后重绑这些名字之一（例如 `__main__._dump_scalar = boom`）可以让编码抛出、把成功降级为 `exception`。值路径的入口名（`_done_with_value`）被绑定进 `_run` 局部、其顶层的 `_check_done_value`/`_encode_json_plain` 是 def 期默认值，但编码器的传递依赖（例如 `_dump_scalar`/`_dump_string`/`json`/`io`——非穷举清单）仍在调用时解析。这是已接受的残余：在 bash-equivalent 信任模型下，这里的重绑只会伤害模型自身的运行，且判决仍必达宿主——`send_done` 的固定兜底帧即使在错误路径编码/写入抛出时也能送达一帧 done。
- **宽 binding 回复会按成员展开宿主侧状态。** 回复经由 [`@deepseek-ai/dsh-session`](../../core/session/README.zh.md) 的 `snapshotJsonValue` 穿越，其 `walkJsonValue` 为每个成员压入一个任务帧，而 binding 回复在 seam 层没有字节上限。因此一个数百万元素的合法回复可以耗尽宿主堆。该性质属于那个共享遍历，而不属于本后端——worker-thread 后端消费同一个函数——所以修复应落在 `packages/core/session`，让所有消费方一并受益。
- **程序用同步的 `t.join()` 连接一个跨线程 binding 会死锁。** 这是 `process` 隔离后端特有的：回复泵运行在子进程的主事件循环上，因此当程序的主协程对一个仍在等待 binding 回复的 worker 线程调用 `t.join()` 时，join 会阻塞承载泵的主线程事件循环——正是泵投递该回复所需的循环——该 worker 的 `await` 直到墙钟才会恢复。worker-thread 后端不共享此结构，所以修复应落在这里，而非 `packages/core/session`。
