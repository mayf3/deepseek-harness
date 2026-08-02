# Agent Note: CPython 后端中的结算、分帧与生命周期修复

Status: implemented

[English](2026-07-31-code-runtime-python-settlement-fixes.md) | 中文

## Problem

用于 Code Mode 的 CPython 子进程后端建立在 [fd-3 帧协议](../architecture/2026-07-31-code-runtime-python-fd3-protocol.md)之上，把每个程序结果都 resolve 成一个 `CodeRunResult`，仅在 seam 被误用时才 reject `run()`，并且会 dispose 到完全停稳，从而没有任何子进程存活得比 fiber 更久。一连串审查暴露出一些缺陷，它们以单元测试覆盖率无法捕获的方式破坏了这些契约：每一个都藏在一处 `/* v8 ignore */` 之后、一个读起来像修复但实际并非修复的捕获可调用对象之后、一处透过 seam 不可见的内存效应之后、一处重复计数的加载期上界之后、一处存活者能够熬过的进程组升级之后，或者一处静默死锁的跨事件循环完成之后。每处修复都附带一个在缺少它时会失败的测试。

## Decision

七处相互独立的修正，各自位于拥有对应缺陷的包中。

### Boot-write failure no longer rejects run()

在 [`src/index.ts`](../../../../packages/code-runtime/code-runtime-python/src/index.ts) 中，fd-3 引导帧写入是 `run()` 同步初始化阶段的最后一条语句。它的 `catch` 会调用 `finish()`，而 `finish()` 读取 `wallTimer` 和 `onAbort`，并通过 `settle()` 读取 `live`。这些绑定是 `const`，且声明在引导写入之后，因此在同步写入失败时，`finish()` 会在它们处于暂时性死区（temporal dead zone）时访问它们，从而抛出一个 `ReferenceError`。该错误逃出了 Promise executor 并 reject 了 `run()`，违反了 seam 的"结果一律 resolve"契约：调用方看到的是一个被抛出的错误，而不是 catch 构造的 `worker-exit`。现在引导写入代码块被放到 `wallTimer`、`onAbort` 和 `live` 初始化之后，并且那处曾把该分支从覆盖率中隐藏的 `/* v8 ignore */` 已被移除，从而使该 catch 被纳入度量。

### Log capture is serialized against settlement

在 [`py/bootstrap.py`](../../../../packages/code-runtime/code-runtime-python/py/bootstrap.py) 中，主协程上的结算 `flush_out()`／`flush_err()` 会读取并清空各个流的 `_pending` 列表，并修改共享的 `LogBuffer` 账本。模型代码可能启动一些 daemon 线程，其 `print`／`write` 会并发地修改同一状态。捕获绑定方法（`out_stream.flush_line`）只解决了结算调用哪个可调用对象的问题，而没有解决它在执行途中读取什么的问题：一次交错的 flush 可能拼接一个正在其下被修改的 `_pending` 列表，从而破坏账本并丢失 `done` 帧，使该次运行一直拖到墙钟超时。现在 `LogBuffer` 持有一把由两个流共享的可重入锁；`_LogStream.write` 和 `flush_line`，以及 `LogBuffer.push`，都会获取该锁，因此整个读-改-写过程在多线程间是原子的。

### Fd-3 residual is copied, not viewed

同样在 `src/index.ts` 中，在对待处理 fd-3 分片的 `Buffer.concat` 结果按换行符做循环之后，剩余的不完整行被以它被切出的 `subarray` 视图形式向前传递。视图会使整个 concat 的底层分配保持存活，因此一个大帧后面跟着一个极小的尾部片段，会钉住整整一帧大小的内存，而 `pendingBytes`（被设为该片段的长度）报告的值远小于实际保留的内存。现在，残余数据通过导出的 `detachResidual` 辅助函数被分离到一个大小恰当的新 `Buffer` 中，从而让 concat 分配得以被回收，并使 `pendingBytes` 成为一个诚实的度量值。

### Output-cap load bound is ceiling minus envelope, not divided by six

那处在加载期拒绝比单个 fd-3 帧所能承载更大的 `maxLogBytes`／`maxValueBytes` 的检查，会把帧上限除以六以应对最坏情况下的转义膨胀。但这两项预算都是以已转义的序列化字节来计量的：宿主日志账本按 `Buffer.byteLength(JSON.stringify(text))` 计费，而 `checkDoneValue` 度量的是转义后的形式，因此一个在上限之内被放行的载荷在传输时最多占用 `cap + envelope`；转义已经包含在计费之内，不能再被乘一次。现在该上界为 `FRAME_CEILING_BYTES - FRAME_ENVELOPE_BYTES`，未使用的 `MAX_JSON_ESCAPE_EXPANSION` 常量已被删除。旧的上界并非不安全（它是放行不足），但它静默地禁止了合法的大上限。

### Same-group survivors are reaped before the fiber goes quiescent

模型程序可能在子进程自己的进程组里（没有 `setsid`，因此 `kill(-pid)` 能到达它）留下一个后代，它忽略 SIGTERM，但释放了继承而来的 stdout／stderr／fd-3 管道。随后 leader 退出，由于管道已被抽空，它的 `close` 触发，于是结算在那个后代仍存活时运行。`kill()` 在 SIGTERM 之后装设一个 `unref` 的 SIGKILL 定时器；本次修复是，当有一次升级正在进行时，`settle()` 既不立即 resolve 该次运行的 `finished` promise，也不立即把该运行从 `live` 中移除。取而代之的是，当 `killing` 被置位且进程组尚未为空时（`process.kill(-pid, 0)` 不抛出 ESRCH），它在一个 ref 的定时器上轮询该进程组，以 `graceMs + CLOSE_REAP_MARGIN_MS` 为界，仅当进程组已清空后才把该运行从 `live` 移除并 resolve `finished`。这个 ref 的轮询是承重部分：它让宿主事件循环保持存活，直到 SIGKILL 真正回收了该进程组，因此即使是一个短命的宿主（一次性的 headless 运行、一个配置子进程）也无法退出并把存活者 reparent 给 init。把 `live` 的移除推迟，正是让一个与刚返回的 `run()` 竞争的 `dispose()` 仍会 await 该存活者的原因：若在回收之前就把运行从 `live` 移除，teardown 会快照到一个空集合并在后代仍存活时返回。在正常情况下（leader 是唯一成员），第一次探测返回 ESRCH，结算以零附加延迟完成收尾。`teardown()` 会 await 每次运行的 `finished`，因此 dispose 是真正完全停稳的，与其 JSDoc 相符——包括对一个已经 resolve 的运行也是如此。

结算还会在进程组被确认为空的那一刻取消 SIGKILL 定时器（正常路径，以及轮询看到存活者已消失时）。让它继续处于装设状态会暴露一个 PID 复用隐患：一个在 leader 被回收后仍挂起长达 `graceMs` 的 `kill(-pid)`，可能在内核复用了 leader 的 pid 之后击中一个被回收（recycled）的 pgid，从而 SIGKILL 掉一个无关的进程组（`killGroup` 吞掉 ESRCH 并无帮助——危险恰恰是那次针对被复用进程组成功执行的 kill）。在空进程组探测时清除它，把复用窗口收窄到只剩真正存在存活者的情形，此时进程组不可能为空以供复用。

### RLIMIT clamps against the inherited soft limit, not only the hard

在 [`py/bootstrap.py`](../../../../packages/code-runtime/code-runtime-python/py/bootstrap.py) 中，`_clamped` 仅用继承而来的 HARD 限制来约束一个请求的 `(soft, hard)` rlimit 对。一个继承了低于请求值的软限制的部署——比如继承 `(100, 200)`、请求 `(150, 160)`——会拿回 `(150, 160)`，把有效软限制从 100 抬高到 150：对 `RLIMIT_AS` 而言这放松了内存上限，对 `RLIMIT_CPU` 而言它推迟了 SIGXCPU，两者都违反了"取配置值与继承值中最严格者"。现在 `_clamped` 用每一侧各自继承而来的对应值来约束该侧（`RLIM_INFINITY` 不施加任何上限），随后把 soft 钉在 hard 之下，因此 `setrlimit` 绝不会看到一个倒置的对。结算时的 CPU 复查（`die_if_cpu_exhausted`）遵循同一规则：它把已消耗的 CPU 与实际生效的、被夹紧的 `cpu_soft` 比较，而不是与配置的 `cpuSeconds` 比较，因此一个捕获 SIGXCPU、在返回前消耗超过更严格的继承软限制的程序会被报告为 timeout，而非误判为成功。

### Binding replies complete on the calling loop's thread

同样在 `py/bootstrap.py` 中，一个绑定回复 Future 是在运行 `dispatch` 的那个事件循环上创建的。当模型通过 `asyncio.run(tools.x(...))` 从一个工作线程调用某个绑定时，该 Future 属于该线程的事件循环，而不是 `_pump_replies` 读取回复的主事件循环。`asyncio.Future` 不是线程安全的：从另一个线程完成它并不会唤醒它自己的事件循环，因此直接的 `set_result`／`set_exception` 会让那个正在等待的线程被搁置，该次运行退化为墙钟超时。现在每个待处理条目都会在记录 Future 的同时记录其 Future 所属的事件循环，`_pump_replies` 通过该事件循环的 `call_soon_threadsafe` 来完成它。共享的 `pending`／`next_id` 状态由一把 `threading.Lock` 保护，该锁跨越 id 认领、fd-3 写入和计数器推进这三步持有，因此并发调用方无法以违反宿主所要求的 id 顺序来交错帧。对一个已经关闭的事件循环（工作线程已结束、在回复到达前放弃了它的调用）调用 `call_soon_threadsafe` 会抛出 `RuntimeError`；该调度被包裹起来，使这个已无意义的回复被丢弃，而不是让异常终结 pump 任务并搁置此后的每一个回复。

## Testing

- `tests/boot-write-failure.spec.ts` 对 `spawn` 做 mock，使 fd-3 管道在引导写入时抛出异常（这是真实子进程无法被迫进入的唯一路径），并断言 `run()` resolve 出一个 `worker-exit` 而非 reject。它被隔离在自己的 spec 中，因此真实子进程测试套件不受影响。
- `tests/residual-detach.spec.ts` 对 `detachResidual` 做单元测试：向前传递的副本与残余数据相等、拥有一个大小与其自身长度一致的底层存储（fixture 保持在 Node 的 Buffer 池阈值之上），并且不与源帧的 `ArrayBuffer` 共享。
- `tests/runtime.spec.ts`：output-cap 用例断言 `ceiling - envelope` 上界（268435392）及其消息。一个 daemon 线程用例驱动四个线程穿过结算的 flush 发出未结束的写入。same-group 回收用例 spawn 一个忽略 SIGTERM 的同进程组后代，它释放管道并递增一个心跳文件；该测试断言在宽限窗口的 SIGKILL 之后心跳停止：无论被杀死的后代是被回收还是作为僵尸进程滞留，这个断言都成立，因此它在 PID 1 不 wait() 孤儿进程的环境下同样成立。cross-loop 用例在主协程通过 `await asyncio.sleep` 让出时，从一个工作线程自己的 `asyncio.run` 事件循环运行一个绑定，断言该回复完成往返而不是超时。inherited-soft-limit 用例通过一个 `ulimit -S -t` 包装脚本运行解释器，将 CPU 软限制设为低于 `cpuSeconds`，并断言实际应用的 `RLIMIT_CPU` 软限制是继承来的值，而不是配置的值（用 CPU 而非地址空间，因为 macOS 忽略 `ulimit -v`）。一个配套用例继承 1 秒的 CPU 软限制，让程序捕获 SIGXCPU 并忙循环越过它，断言结算复查报告 timeout——证明复查用的是实际生效的软限制，而不是配置的 `cpuSeconds`。

## Alternatives considered

**保留引导写入处的 `/* v8 ignore */`，只修复顺序。** 已否决：正是那处 ignore 让这个 TDZ 回归得以未被发现地进入代码库。移除它使该 catch 成为被度量的分支，因此按文件计的 100% 覆盖率现在能证明该失败路径确实被执行。

**通过捕获更多绑定方法来修复 flush 竞态。** 已否决：这正是已经失败过的做法。绑定一个可调用对象解决的是引用解析，而不是对该可调用对象所读取的可变状态的并发访问。只有对共享账本施加互斥才能消除该竞态。

**用大小阈值来保护残余数据（只复制大帧）。** 已否决：该分支在每次包含换行符的读取时运行一次，复制的规模受残余数据自身长度约束（始终是一个不完整行），而阈值会引入一个可调参数和第二条代码路径，却换不来任何可度量的节省。无条件地做大小恰当的复制更简单，且始终正确。

**通过 seam 断言残余数据的内存效应。** 已否决：被保留的分配透过 `CodeRunResult` 不可观测，因此黑盒测试无法区分已修复与未修复。转而抽取出 `detachResidual`，把底层存储的不变量变成一个确定性的单元测试。

**仅用一个发后不理的 `unref` SIGKILL 定时器来回收同进程组存活者。** 已否决：`unref` 的定时器不会让宿主保持存活，因此一个在宽限窗口内退出的宿主（一次性运行、一个配置子进程）永远不会触发 SIGKILL，存活者被 reparent 给 init，这是同一个"没有子进程存活得比 fiber 更久"的违规换了个形态，而且 `teardown` 的"await 每个子进程退出"的 JSDoc 会变为不实。在一个 ref 的轮询上 await 进程组的消亡，让宿主恰好保持存活足够长以完成回收，在常见的空进程组情形下代价为零。

**用 `process.kill(pid, 0)` 抛出 ESRCH 来断言回收。** 已否决：一个被 SIGKILL 的进程会作为僵尸进程滞留，直到它的父进程 `wait()` 它，而在一个 PID 1 不回收孤儿进程的容器里，signal-0 探测会持续成功，因此该断言会在跨环境时误报失败。一个停止推进的心跳文件检测的是"不再执行"，而被回收的进程和僵尸进程都满足这一点。

**用一个普通的 `set_result` 完成跨事件循环的 Future 并依赖 GIL。** 已否决：GIL 序列化字节码，但并不使 `asyncio.Future` 跨事件循环安全：从一个并非其事件循环所属的线程完成一个 Future，不会调度它的回调，也不会唤醒该事件循环。在拥有该 Future 的事件循环上调用 `call_soon_threadsafe` 才是有文档记载的机制。

**在结算之后让 SIGKILL 定时器继续处于装设状态（早先的同进程组修复）。** 已否决：一个被留待在 leader 被回收后长达 `graceMs` 才触发的 `unref` 定时器，可能 `kill(-pid)` 一个被回收（recycled）的 pgid，击中一个无关的进程组；危险是那次成功执行的 kill，而 `killGroup` 吞掉 ESRCH 无法阻止它。在进程组被确认为空后清除该定时器，把复用窗口收窄到真正存在存活者的情形，此时进程组不为空以供复用。

**只用继承而来的硬限制来约束 rlimit。** 已否决：那会静默地抬高一个比请求更严格的继承软限制，放松了该约束本应保持的那种收束。用每一侧各自继承而来的界来约束该侧（随后把 soft 钉在 hard 之下），在 soft 和 hard 两者上都保持配置值与继承值中的最严格者。

## Consequences

seam 的"只 resolve、不 reject"契约在引导写入路径上得以成立，且覆盖率是被度量的。日志捕获是线程安全的，代价是每次写入和 flush 都要获取一次可重入锁。fd-3 残余数据的内存受实际保留的字节数约束。输出上限放行一个帧所能承载的每一个值。dispose 面对同进程组存活者是真正完全停稳的（以既有的宽限预算为界，在进程组已为空时代价为零，并且一旦进程组清空就清除 SIGKILL 定时器，从而一次滞留的 kill 无法击中一个被回收的 pgid），RLIMIT 强制在 soft 和 hard 两者上都保持配置值与继承值中的最严格者，并且从模型创建的线程调用的绑定会完成而不是超时。每处修复都附带一个在缺少它时会失败的测试，因此这七处中任何一处未来若发生回归都会变红。
