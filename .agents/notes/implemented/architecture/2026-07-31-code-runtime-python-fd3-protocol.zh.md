# Agent Note: the code-runtime-python fd-3 frame protocol

Status: implemented

[English](2026-07-31-code-runtime-python-fd3-protocol.md) | 中文

## Problem

CPython code-runtime 后端（`@deepseek-ai/dsh-code-runtime-python`，分多个 PR 落地）在一个全新的 `python3 -I` 子进程里运行每个模型程序，并把 binding 调用和完成值通过子进程的 fd 3 桥接。这条通道需要两侧一致的 wire protocol，而 host 不能信任它：模型代码对 fd 3 有完全访问权、可以伪造任意帧，所以每个入站帧都是 host 必须先校验并重建才能读取的敌意输入。协议还必须承载无深度限制的 lossless JSON，因为 seam 的 `CodeJsonValue` 深度无界，而 `JSON.stringify`/`json.dumps` 都有递归深度限制。

本层只交付这个协议，使得庞大的 `PythonCodeRuntime` 实现及其真子进程集成测试能落在一个已 review 的 wire contract 之上，而不是与它揉在一起到达。父 stack 把 [#436](https://github.com/deepseek-harness/deepseek-harness/pull/436)——一个 9000 行的单一 PR——拆成可 review 的层；本 PR 是协议层，base 是 [seam 扩展](2026-07-31-code-runtime-portable-identifier-seam.md)。

## Decision

`src/protocol.ts` 是 wire vocabulary 的 host 侧及其敌意帧编解码：

- **`validateChildFrame`** 对每个入站帧做形状校验并重建。编译期 union 在 fd 3 上毫无意义——伪造帧可携带 `null`、被污染的字段，或省略必需字段——所以每个被接受的帧都逐字段重建：伪造的额外字段绝不随行，非有限的 call id 绝不会被回显进 reply，垃圾返回 `undefined` 被丢弃，而不是在 host 的 message handler 里抛错。
- **`encodeJsonPlain` / `checkDoneValue` / `hasUnsafeIntegerToken` / `hasNonLosslessNumber`** 是 lossless-JSON 编解码器与计量器。它们迭代遍历（显式栈，非递归），使低于字节预算的深层值能完整穿越；`checkDoneValue` 把字节计量和数字无损性折进一次有界遍历，在把子节点入栈之前就拒绝超预算 payload，防止一个低于帧上限的伪造值迫使 host 分配数百 MB。超出安全范围的整数型 double 通过 `BigInt` 数字序列化，穿越的是精确整数而非 `String()` 的舍入形式。
- **`logTruncationMarker`** 产出日志 ledger 耗尽字节预算时发出的带内标记文本。

`py/protocol.py` 用 `TypedDict` 镜像消息形状，并重新声明两侧都会 EXECUTE 的两个面——`PROTOCOL_FD = 3` 与 `log_truncation_marker`——文本逐字节一致。

包骨架（`package.json`、`tsconfig.json`、`tsdown.config.ts`、`src/index.ts`、`src/invariant.ts`、README 三件套）在此交付，而非放到后续 stack 层：`check-workspace-constraints` 无条件读取每个 `packages/<group>/<pkg>` 的 package.json，coverage 与 invariant-topology gate 也要求包在其目录出现的那一刻即存在且可构建。后续的 backend-core PR 会用 `PythonCodeRuntime` 扩展 `src/index.ts` 并增补 `package.json` 的依赖；因为它 base 在本分支上，那些是编辑，不是冲突。

## Wire contract

帧是 fd 3 上的 JSON-lines，每行一个对象，让 stdout/stderr 空出给程序自己的输出。Child → host：`boot-ack`、`call`、`log`、`done`。Host → child：`boot`（首帧）、`run`（在 `boot-ack` 之后）、以及每个 `call` 对应一个 `reply`。`log` 帧的 `truncated` 标志标记那个本身就是子进程 ledger 截断标记的帧，使 host 在与子进程相同的点停止捕获，而不是从自己的预算去推断。`done.error.kind` 是 `exception`、`invalid-output`、`output-limit` 之一；wall/CPU 预算、abort、substrate 死亡都在 host 侧观测，不作为帧携带。

## Mirror alignment

#436 的 round-12 review 发现 `py/protocol.py` 相对 `src/protocol.ts` 有三处声明陈旧——`LogMessage` 缺 `truncated`、`DoneMessage.error` 缺 `kind`、`Namespace` 缺可选的 `errorClass`。本 PR 在搬运该文件时对齐了这三处，不把陈旧镜像带过来。由于这些声明是 `TypedDict`（在受信任的 Python 侧无运行时强制），自动化 guard 只覆盖两侧都会执行的部分：`tests/protocol-mirror.e2e.ts` 启动一个真实 `python3`，从 `py/protocol.py` 读取 `PROTOCOL_FD` 与 `log_truncation_marker`，并在若干字节预算下断言它们等于 TypeScript 常量。

## Alternatives considered

**把 Python JSON codec（`_encode_json_plain` / `_decode_json_plain`）挪进 `py/protocol.py` 以与 `protocol.ts` 跨侧对称。** 拒绝。仓库的 “prefer symmetry for parallel values” 规则指向真正平行的值；这两者不是。`protocol.ts` 里的 host 侧 codec 校验的是敌意输入，自包含。Python codec 在受信任侧产出输出，且耦合于 bootstrap 内部 helper（`_Emit`、`_dump_scalar`/`_dump_string`/`_dump_float`、`LogBuffer` 的成本核算、`_check_done_value`、`_lossless_json_violation`）；只把两个入口挪过去会把这一整片拖进 `protocol.py`，或制造 `bootstrap.py` ↔ `protocol.py` 的 import 环。真正的跨侧平行是 “host 校验入站（`protocol.ts`） ↔ child 信任 host 并发出（`bootstrap.py`）”，这个对称性被保留：`protocol.py` 保持它在 TS 侧一样的纯 wire-vocabulary 镜像定位。Python codec 留在 `bootstrap.py`，由 backend-core PR 交付。

**把包骨架推迟到“拥有” package.json 的 backend-core PR。** 拒绝：workspace-constraint、coverage、invariant-topology gate 会在 `code-runtime-python` 目录一存在而包不可构建时立即失败。stacked 拆分无法在一个尚不能编译的包里创建源文件。

## Consequences

收获：fd-3 协议及其敌意输入 codec 作为自包含、unit 全覆盖的一层落地，round-12 review 发现的 py/ts 镜像漂移被修复，并有一个执行中的 guard 防其复发。backend-core PR 建立在已 review 的 wire contract 之上。

代价：`src/index.ts` 与 `package.json` 在此以最小形态引入，并由 backend-core PR 编辑（而非创建）。`py/protocol.py` 中两个可执行面之外的 `TypedDict` 形状仍由 review 加后端真子进程套件守护，而非 mirror e2e 测试——这是跨语言比较类型声明的固有局限。
