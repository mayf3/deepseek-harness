# Agent Note: CPython 后端的三处结算与分帧修复

Status: implemented

[English](2026-07-31-code-runtime-python-settlement-fixes.md) | 中文

## Problem

用于 Code Mode 的 [CPython 子进程后端](2026-07-17-code-runtime-python.md)把每个程序结果都 resolve 成一个 `CodeRunResult`，仅在 seam 被误用时才 reject `run()`。三个缺陷以单元测试覆盖率无法暴露的方式破坏了这一契约，因为它们各自藏在一处 `/* v8 ignore */` 之后、藏在一条读起来像修复但实际并非修复的"捕获可调用对象"注释之后，或藏在一处透过 seam 不可见的内存效应之后。这些缺陷是通过审查当时的后端代码发现的，而非由某个失败的测试发现，因此每处修复都附带一个在缺少该修复时会失败的测试。

## Decision

三处相互独立的修正，各自位于拥有对应缺陷的包中。

### Boot-write failure no longer rejects run()

在 [`src/index.ts`](../../../../packages/code-runtime/code-runtime-python/src/index.ts) 中，fd-3 引导帧写入是 `run()` 同步初始化阶段的最后一条语句。它的 `catch` 会调用 `finish()`，而 `finish()` 读取 `wallTimer` 和 `onAbort`，并通过 `settle()` 读取 `live`。这些绑定是 `const`，且声明在引导写入之后，因此在同步写入失败时，`finish()` 会在它们处于暂时性死区（temporal dead zone）时访问它们，从而抛出一个 `ReferenceError`。该错误逃出了 Promise executor 并 reject 了 `run()`，违反了 seam 的"结果一律 resolve"契约：调用方看到的是一个被抛出的错误，而不是 catch 构造的 `worker-exit`。现在引导写入代码块被放到 `wallTimer`、`onAbort` 和 `live` 初始化之后，并且那处曾把该分支从覆盖率中隐藏的 `/* v8 ignore */` 已被移除，从而使该 catch 被纳入度量。

### Log capture is serialized against settlement

在 [`py/bootstrap.py`](../../../../packages/code-runtime/code-runtime-python/py/bootstrap.py) 中，主协程上的结算 `flush_out()`／`flush_err()` 会读取并清空各个流的 `_pending` 列表，并修改共享的 `LogBuffer` 账本。模型代码可能启动一些 daemon 线程，其 `print`／`write` 会并发地修改同一状态。捕获绑定方法（`out_stream.flush_line`）只解决了结算调用哪个可调用对象的问题，而没有解决它在执行途中读取什么的问题：一次交错的 flush 可能拼接一个正在其下被修改的 `_pending` 列表，从而破坏账本并丢失 `done` 帧，使该次运行一直拖到墙钟超时。现在 `LogBuffer` 持有一把由两个流共享的可重入锁；`_LogStream.write` 和 `flush_line`，以及 `LogBuffer.push`，都会获取该锁，因此整个读-改-写过程在多线程间是原子的。

### Fd-3 residual is copied, not viewed

同样在 `src/index.ts` 中，在对待处理 fd-3 分片的 `Buffer.concat` 结果按换行符做循环之后，剩余的不完整行被以它被切出的 `subarray` 视图形式向前传递。视图会使整个 concat 的底层分配保持存活，因此一个大帧后面跟着一个极小的尾部片段，会钉住整整一帧大小的内存，而 `pendingBytes`（被设为该片段的长度）报告的值远小于实际保留的内存。现在，残余数据通过导出的 `detachResidual` 辅助函数被分离到一个大小恰当的新 `Buffer` 中，从而让 concat 分配得以被回收，并使 `pendingBytes` 成为一个诚实的度量值。

## Testing

- `tests/boot-write-failure.spec.ts` 对 `spawn` 做 mock，使 fd-3 管道在引导写入时抛出异常（这是真实子进程无法被迫进入的唯一路径），并断言 `run()` resolve 出一个 `worker-exit` 而非 reject。它被隔离在自己的 spec 中，因此真实子进程测试套件不受影响。
- `tests/residual-detach.spec.ts` 对 `detachResidual` 做单元测试：向前传递的副本与残余数据相等、拥有一个大小与其自身长度一致的底层存储，并且不与源帧的 `ArrayBuffer` 共享。
- `tests/runtime.spec.ts` 新增一个真实子进程用例：四个 daemon 线程持续发出未结束的写入，直到函数体返回、结算执行 flush 的那一刻，并反复运行以让交错真正出现；该次运行必须干净地完成。纯数据竞态没有单一的坏输入可供 reject，因此该测试最大化重叠而非断言一个确定性的 reject。

## Alternatives considered

**保留引导写入处的 `/* v8 ignore */`，只修复顺序。** 已否决：正是那处 ignore 让这个 TDZ 回归得以未被发现地进入代码库。移除它使该 catch 成为被度量的分支，因此按文件计的 100% 覆盖率现在能证明该失败路径确实被执行。

**通过捕获更多绑定方法来修复 flush 竞态。** 已否决：这正是已经失败过的做法。绑定一个可调用对象解决的是引用解析，而不是对该可调用对象所读取的可变状态的并发访问。只有对共享账本施加互斥才能消除该竞态。

**用大小阈值来保护残余数据（只复制大帧）。** 已否决：该分支在每次包含换行符的读取时运行一次，复制的规模受残余数据自身长度约束（始终是一个不完整行），而阈值会引入一个可调参数和第二条代码路径，却换不来任何可度量的节省。无条件地做大小恰当的复制更简单，且始终正确。

**通过 seam 断言残余数据的内存效应。** 已否决：被保留的分配透过 `CodeRunResult` 不可观测，因此黑盒测试无法区分已修复与未修复。转而抽取出 `detachResidual`，把底层存储的不变量变成一个确定性的单元测试。

## Consequences

现在 seam 的"只 resolve、不 reject"契约在引导写入路径上得以成立，且其覆盖率是被度量而非被忽略的。日志捕获现在是线程安全的，代价是每次写入和 flush 都要获取一次可重入锁，这相对于该路径上已有的 os.write 可以忽略不计。fd-3 残余数据的内存现在受实际保留的字节数约束，且 `pendingBytes` 度量的正是它所声称的值。每处修复都附带一个在缺少它时会失败的测试，因此这三处中任何一处未来若发生回归都会变红。
