---
description: "DeepSeek Harness 代码执行 seam 的 CPython 子进程实现，提供 fd-3 binding、资源限制、日志捕获与进程组拆卸。"
kind: "package-reference"
---

# @deepseek-ai/dsh-code-runtime-python

[English](README.md) | 中文

[`@deepseek-ai/dsh-code-runtime`](../code-runtime/README.zh.md) seam 的 CPython 子进程实现。与 [`@deepseek-ai/dsh-code-runtime-worker-thread`](../code-runtime-worker-thread/README.zh.md) 配套；以全新的 `python3` 子进程取代 Node worker 线程，让模型代码从 TypeScript 换成 Python。

本包以默认导出提供 `PythonCodeRuntime`。该插件以 `language: 'python'`、`isolation: 'process'` 注册为 `codeRuntime`。每次 `run()` 启动一个全新的 `python3 -I` 进程，通过 fd 3 发送 boot 帧和程序，并为每个程序结果 resolve 一个 `CodeRunResult`——仅在 seam 被误用时才 reject（binding 命名空间不合法或 config 非正）。子进程把程序作为 async 函数体运行，因此顶层 `await` 与 `return` 都可用；binding 调用经 fd 3 以 JSON-lines 回传。containment 不是安全边界——模型代码具有等同 bash 的信任级别；空环境、`RLIMIT_CPU`／`RLIMIT_AS`、墙钟上限与对子进程进程组的 `SIGTERM`→grace→`SIGKILL` 拆卸共同提供 containment。

## Wire protocol

host 与 CPython 子进程在子进程的 fd 3 上交换一个无版本号的 JSON-lines 协议——每行一个 JSON 对象，让 stdout/stderr 空出给程序自己的输出。`src/protocol.ts` 是 host 侧；`py/protocol.py` 在 Python 侧镜像其帧词汇与共享的截断标记文本。

- **fd 3，而非 stdout** —— Node 通过 `stdio: ['pipe','pipe','pipe','pipe']` 按位置钉住通道；Python bootstrap 读取相同的 `PROTOCOL_FD` 常量。JSON-lines 帧。
- **host 把每个入站帧当作敌意输入** —— 模型代码对 fd 3 有完全访问权、可通过它发送任意内容，所以 `validateChildFrame` 在 host 读取前对每个帧做形状校验并重建：伪造的额外字段绝不随行，非数字的 call id 绝不会被回显进 reply，垃圾降为 `undefined` 被丢弃，而不是在 host 的 message handler 里抛错。Python 侧信任 host 回复（host 不受模型控制）。
- **lossless-JSON 穿越** —— 完成值与 binding 参数以精确 JSON 穿越。`encodeJsonPlain` 无递归地序列化一个 `JSON.parse` 产出的值，使低于字节预算的深层值能完整穿越，而不是死在 `JSON.stringify` 的栈限制上；`checkDoneValue` 在一次有界遍历中同时计量伪造完成值的字节长度与数字无损性，在把子节点入栈之前就拒绝超预算 payload；`hasUnsafeIntegerToken` 读取原始帧文本，捕获 `JSON.parse` 会静默舍入的整数 token；`hasNonLosslessNumber` 拒绝无字节上限的 `call.args` 中的非有限数或负零。超出安全范围的整数型 double 通过 `BigInt` 数字序列化，穿越的是精确整数而非 `String()` 的舍入形式。
- **共享截断标记** —— `logTruncationMarker(maxBytes)` 在两侧产出逐字节一致的文本，使被截断的日志运行无论从哪侧触达上限都读起来一致。`log` 帧的 `truncated` 标志把子进程 ledger 自身的标记与程序输出区分开。

## Configuration

每个上限都是带默认值的、经校验的 `Config` 字段，可从 `cordis.yml` 修改（无硬编码可调项）。`cpuSeconds`（默认 60）是 `RLIMIT_CPU` 的整秒预算；子进程把软限设为 `cpuSeconds`、硬限设为 `cpuSeconds + 1`，因此内核在软限处发出的 `SIGXCPU` 被归类为 `timeout`，而 +1 秒的硬限是 `SIGKILL` 兜底。`maxWallMs`（默认 600000）是墙钟上限，为一个在等待无人 resolve 的 promise 的程序兜住 CPU 时间。`addressSpaceMb`（默认 512）是 `RLIMIT_AS` 上限，在 Darwin 上不施加（那里映射进每个进程的 dyld 共享缓存超过任何实际上限；`cpuSeconds` 与 `maxWallMs` 仍约束运行）。`maxLogBytes`（默认 65536）是共享的捕获日志字节预算；`maxValueBytes`（默认 32768）为完成值设上限；`graceMs`（默认 3000）是 `SIGTERM`→`SIGKILL` 的 grace 窗口；`pythonBin`（默认 `python3`）是解释器，在子进程以空环境启动前先对 `PATH` 解析。

## Model Experience

Indirectly, through Code Mode in [`dsh-tools`](../../core/tools/README.md), which renders this backend's exact completion value when it fits (or an explicit `invalid-output` / `output-limit` failure), plus the exact `[dsh-code-runtime-python] log capture truncated at <maxLogBytes> bytes` log marker, into a retained `run_code` result.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **跨语言 guard 覆盖执行值与帧字段集，但不覆盖字段类型** —— `tests/protocol-mirror.e2e.ts` 使用真实 `python3` 比较 `PROTOCOL_FD`、日志截断标记，以及每个 `TypedDict` 的必填和可选字段。跨 TypeScript 与 Python 比较字段类型在此没有机械等价物，因此类型级漂移由 review 加后端真子进程套件负责。
- **`RLIMIT_AS` 在 macOS 上不施加** —— 在 exec 时映射进每个进程的 dyld 共享缓存超过任何实际的地址空间上限，内核会拒绝该 `setrlimit` 调用，故 `addressSpaceMb` 在那里被跳过。`cpuSeconds` 与 `maxWallMs` 仍约束每一次运行。
