# Agent Note: CPython 后端中的结算、分帧与生命周期修复

Status: implemented

[English](2026-07-31-code-runtime-python-settlement-fixes.md) | 中文

## Problem

用于 Code Mode 的 CPython 子进程后端建立在 [fd-3 帧协议](../architecture/2026-07-31-code-runtime-python-fd3-protocol.md)之上，把每个程序结果都 resolve 成一个 `CodeRunResult`，仅在 seam 被误用时才 reject `run()`，并且会 dispose 到完全停稳，从而没有任何留在子进程自己进程组内的子进程存活得比 fiber 更久（一个用 `setsid()` 逃出该进程组的后代是有文档记载的例外——见该包 README 的 Known Limitations）。一连串审查暴露出一些缺陷，它们以单元测试覆盖率无法捕获的方式破坏了这些契约：每一个都藏在一处 `/* v8 ignore */` 之后、一个读起来像修复但实际并非修复的捕获可调用对象之后、一处透过 seam 不可见的内存效应之后、一处重复计数的加载期上界之后、一处存活者能够熬过的进程组升级之后、一处静默死锁的跨事件循环完成之后、一处位于结算路径之外的同步抛出之后，或者一处被当作日志边界处理的传输边界之后。大多数行为修复都附带一个在缺少它时会失败的测试；有三处没有，并被如此标注——分块读取帧（一处系统调用次数的改进，没有可跨平台确定性断言的失败）、确认为空后的收尾（它唯一透过 seam 可观测的效应，即一个冻结的心跳，会在 SIGKILL 被投递的瞬间冻结，而修复前"投递即收尾"的代码也会产生同样的结果，用于区分的探测手段是 Alternatives 以跨环境不可靠为由否决的 signal-0 检查），以及共享的 stdout／stderr 预算（它唯一透过 seam 可观测的差异，是一次流中冲刷落在哪条条目边界上，而这取决于两条相互独立的 OS 管道的相对到达时机，`os.sched_yield` 并不能使其确定；它所强化的按管道计的内存界限确实由单管道洪泛测试覆盖）。

## Decision

若干处相互独立的修正，各自位于拥有对应缺陷的包中。

### Boot-write failure no longer rejects run()

在 [`src/index.ts`](../../../../packages/code-runtime/code-runtime-python/src/index.ts) 中，fd-3 引导帧写入是 `run()` 同步初始化阶段的最后一条语句。它的 `catch` 会调用 `finish()`，而 `finish()` 读取 `wallTimer` 和 `onAbort`，并通过 `settle()` 读取 `live`。这些绑定是 `const`，且声明在引导写入之后，因此在同步写入失败时，`finish()` 会在它们处于暂时性死区（temporal dead zone）时访问它们，从而抛出一个 `ReferenceError`。该错误逃出了 Promise executor 并 reject 了 `run()`，违反了 seam 的"结果一律 resolve"契约：调用方看到的是一个被抛出的错误，而不是 catch 构造的 `worker-exit`。现在引导写入代码块被放到 `wallTimer`、`onAbort` 和 `live` 初始化之后，并且那处曾把该分支从覆盖率中隐藏的 `/* v8 ignore */` 已被移除，从而使该 catch 被纳入度量。

### Log capture is serialized against settlement

在 [`py/bootstrap.py`](../../../../packages/code-runtime/code-runtime-python/py/bootstrap.py) 中，主协程上的结算 `flush_out()`／`flush_err()` 会读取并清空各个流的 `_pending` 列表，并修改共享的 `LogBuffer` 账本。模型代码可能启动一些 daemon 线程，其 `print`／`write` 会并发地修改同一状态。捕获绑定方法（`out_stream.flush_line`）只解决了结算调用哪个可调用对象的问题，而没有解决它在执行途中读取什么的问题：一次交错的 flush 可能拼接一个正在其下被修改的 `_pending` 列表，从而破坏账本并丢失 `done` 帧，使该次运行一直拖到墙钟超时。现在 `LogBuffer` 持有一把由两个流共享的可重入锁；`_LogStream.write` 和 `flush_line`，以及 `LogBuffer.push`，都会获取该锁，因此整个读-改-写过程在多线程间是原子的。

### Fd-3 residual is copied, not viewed

同样在 `src/index.ts` 中，在对待处理 fd-3 分片的 `Buffer.concat` 结果按换行符做循环之后，剩余的不完整行被以它被切出的 `subarray` 视图形式向前传递。视图会使整个 concat 的底层分配保持存活，因此一个大帧后面跟着一个极小的尾部片段，会钉住整整一帧大小的内存，而 `pendingBytes`（被设为该片段的长度）报告的值远小于实际保留的内存。现在，残余数据通过导出的 `detachResidual` 辅助函数被分离到一个大小恰当的新 `Buffer` 中，从而让 concat 分配得以被回收，并使 `pendingBytes` 成为一个诚实的度量值。

### Output-cap load bound is ceiling minus envelope, not divided by six

那处在加载期拒绝比单个 fd-3 帧所能承载更大的 `maxLogBytes`／`maxValueBytes` 的检查，会把帧上限除以六以应对最坏情况下的转义膨胀。但这两项预算都是以已转义的序列化字节来计量的：宿主日志账本通过 `jsonStringCostUpTo` 按序列化开销计费（它走到上限而不分配转义后的副本），`checkDoneValue` 度量的是转义后的形式，而生产侧的 `_cap_message` 同样按序列化开销设上限，因此一个在上限之内被放行的载荷在传输时最多占用 `cap + envelope`；转义已经包含在计费之内，不能再被乘一次。现在该上界为 `FRAME_CEILING_BYTES - FRAME_ENVELOPE_BYTES`，未使用的 `MAX_JSON_ESCAPE_EXPANSION` 常量已被删除。旧的上界并非不安全（它是放行不足），但它静默地禁止了合法的大上限。这同一处加载检查还会拒绝一个非整数的 `maxLogBytes`／`maxValueBytes`：子进程通过 `int(...)` 读取每一项预算，而 `int(...)` 会对浮点数向下取整，因此 `maxLogBytes: 3.5` 会在子进程侧截断在 3 字节，而宿主却把小数部分也计入——两侧因此强制着不同的公开配置。在加载期拒绝该浮点数使两侧保持一致，与 worker 后端相符。

### Same-group survivors are reaped before the fiber goes quiescent

模型程序可能在子进程自己的进程组里（没有 `setsid`，因此 `kill(-pid)` 能到达它）留下一个后代，它忽略 SIGTERM，但释放了继承而来的 stdout／stderr／fd-3 管道。随后 leader 退出，由于管道已被抽空，它的 `close` 触发，于是结算在那个后代仍存活时运行。`kill()` 在 SIGTERM 之后装设一个 `unref` 的 SIGKILL 定时器；本次修复是，当有一次升级正在进行时，`settle()` 既不立即 resolve 该次运行的 `finished` promise，也不立即把该运行从 `live` 中移除。取而代之的是，当 `killing` 被置位且进程组尚未为空时（`process.kill(-pid, 0)` 不抛出 ESRCH），它在一个 ref 的定时器上轮询该进程组，以 `graceMs + CLOSE_REAP_MARGIN_MS` 为界，仅当进程组已清空后才把该运行从 `live` 移除并 resolve `finished`。这个 ref 的轮询是承重部分：它让宿主事件循环保持存活，直到 SIGKILL 真正回收了该进程组，因此即使是一个短命的宿主（一次性的 headless 运行、一个配置子进程）也无法退出并把存活者 reparent 给 init。把 `live` 的移除推迟，正是让一个与刚返回的 `run()` 竞争的 `dispose()` 仍会 await 该存活者的原因：若在回收之前就把运行从 `live` 移除，teardown 会快照到一个空集合并在后代仍存活时返回。在正常情况下（leader 是唯一成员），第一次探测返回 ESRCH，结算以零附加延迟完成收尾。`teardown()` 会 await 每次运行的 `finished`，因此 dispose 是真正完全停稳的，与其 JSDoc 相符——包括对一个已经 resolve 的运行也是如此。

结算还会在进程组被确认为空的那一刻取消 SIGKILL 定时器（正常路径，以及轮询看到存活者已消失时）。让它继续处于装设状态会暴露一个 PID 复用隐患：一个在 leader 被回收后仍挂起长达 `graceMs` 的 `kill(-pid)`，可能在内核复用了 leader 的 pid 之后击中一个被回收（recycled）的 pgid，从而 SIGKILL 掉一个无关的进程组（`killGroup` 吞掉 ESRCH 并无帮助——危险恰恰是那次针对被复用进程组成功执行的 kill）。在空进程组探测时清除它，把复用窗口收窄到只剩真正存在存活者的情形，此时进程组不可能为空以供复用。

回收轮询还会处理宿主事件循环被阻塞、越过两个定时器的情形。如果一次同步计算从轮询被调度之前一直占住事件循环、直到越过它的截止时间，那么当事件循环恢复时，轮询定时器和宽限窗口的 SIGKILL 定时器都已逾期，而 Node 会先运行更早调度的轮询——因此宽限窗口的 SIGKILL 可能从未触发。为此截止时间分支会自己发送 SIGKILL（若定时器已运行则该操作幂等），而不是取消尚未触发的升级，随后再额外给予一个 `CLOSE_REAP_MARGIN_MS`，并持续轮询直到进程组被确认为空，因为仅凭信号投递就收尾会在进程组仍在消亡时宣告完全停稳。因此等待的外层上界为 `graceMs + 2 * CLOSE_REAP_MARGIN_MS`。若这段额外余量耗尽而进程组仍非空，一个最终的硬性上界会收尾；该分支带有一处 `/* v8 ignore */`，因为它仅在一个被 SIGKILL 的存活者作为僵尸进程滞留且从未被 `wait()`——一个 PID 1 不回收孤儿进程的容器——时才可达，而这无法在各 CI 平台上确定性地构造出来。该 ignore 的理由陈述的是这种环境依赖性，而不是声称该分支不可能运行，并交叉引用 Alternatives 中以同样理由否决 signal-0 回收断言的那一条。

### RLIMIT clamps against the inherited soft limit, not only the hard

在 [`py/bootstrap.py`](../../../../packages/code-runtime/code-runtime-python/py/bootstrap.py) 中，`_clamped` 仅用继承而来的 HARD 限制来约束一个请求的 `(soft, hard)` rlimit 对。一个继承了低于请求值的软限制的部署——比如继承 `(100, 200)`、请求 `(150, 160)`——会拿回 `(150, 160)`，把有效软限制从 100 抬高到 150：对 `RLIMIT_AS` 而言这放松了内存上限，对 `RLIMIT_CPU` 而言它推迟了 SIGXCPU，两者都违反了"取配置值与继承值中最严格者"。现在 `_clamped` 用每一侧各自继承而来的对应值来约束该侧（`RLIM_INFINITY` 不施加任何上限），随后把 soft 钉在 hard 之下，因此 `setrlimit` 绝不会看到一个倒置的对。结算时的 CPU 复查（`die_if_cpu_exhausted`）遵循同一规则：它把已消耗的 CPU 与实际生效的、被夹紧的 `cpu_soft` 比较，而不是与配置的 `cpuSeconds` 比较，因此一个捕获 SIGXCPU、在返回前消耗超过更严格的继承软限制的程序会被报告为 timeout，而非误判为成功。SIGXCPU 诊断不再把配置的 `cpuSeconds` 说成实际生效的预算——在一个更严格的继承软限制之下那个数字是错的——而是报告 CPU 时间是在"至多配置的 N 秒"处被耗尽，这一表述无论哪个限制先触发都成立。

### Binding replies complete on the calling loop's thread

同样在 `py/bootstrap.py` 中，一个绑定回复 Future 是在运行 `dispatch` 的那个事件循环上创建的。当模型通过 `asyncio.run(tools.x(...))` 从一个工作线程调用某个绑定时，该 Future 属于该线程的事件循环，而不是 `_pump_replies` 读取回复的主事件循环。`asyncio.Future` 不是线程安全的：从另一个线程完成它并不会唤醒它自己的事件循环，因此直接的 `set_result`／`set_exception` 会让那个正在等待的线程被搁置，该次运行退化为墙钟超时。现在每个待处理条目都会在记录 Future 的同时记录其 Future 所属的事件循环，`_pump_replies` 通过该事件循环的 `call_soon_threadsafe` 来完成它。共享的 `pending`／`next_id` 状态由一把 `threading.Lock` 保护，该锁跨越 id 认领、fd-3 写入和计数器推进这三步持有，因此并发调用方无法以违反宿主所要求的 id 顺序来交错帧。对一个已经关闭的事件循环（工作线程已结束、在回复到达前放弃了它的调用）调用 `call_soon_threadsafe` 会抛出 `RuntimeError`；该调度被包裹起来，使这个已无意义的回复被丢弃，而不是让异常终结 pump 任务并搁置此后的每一个回复。

### The blocking frame reader reads in chunks, not byte by byte

`ProtocolChannel.read_frame`（用于 `boot` 和 `run` 握手帧）过去通过在无缓冲（`buffering=0`）fd 上的 `FileIO.readline()` 读取，这会为每个字节发起一次 `os.read(1)`。`run` 帧在 `RLIMIT_CPU` 生效之后才到达，因此一个合法的数兆字节程序会在 `ast.parse` 运行之前，在数以百万计的单字节系统调用中烧掉数秒 CPU——有可能仅在读取这一步就耗尽预算。现在它以 `_READ_CHUNK_BYTES` 为单位分块读取，写入异步读取器已经使用的那同一个 `_pending` 残余缓冲区（包裹用的 `os.fdopen` 对象已被移除；两个读取器都直接调用 `os.read(self._fd, ...)`），因此读取开销微不足道，并且越过换行符的预读也为下一帧保留了下来。两个读取器都跟踪一个持续推进的扫描偏移（`find(b"\n", scanned)`），使一个跨多个分块累积起来的大帧只被扫描一次，而不是每来一个分块就从索引 0 重新扫描——分块式重扫会把逐字节的开销换成同一大帧路径上 O(N²) 的 memchr 开销。

### Synchronous spawn failure resolves worker-exit, not reject

同样在 `src/index.ts` 中，`spawn` 是在结算 Promise 的 executor 存在之前被调用的。Node 只把一组固定的 spawn errno（EACCES、EAGAIN、EMFILE、ENFILE、ENOENT）推迟为一个异步的 `error` 事件，而结算路径已经把它转成一个 `worker-exit`；其余每一个 errno 都会从 `spawn` 同步抛出。一个长度超过平台 PATH_MAX 的 `pythonBin` 能通过加载期校验（非空、无 NUL），却会让 `spawn` 在此处抛出 `ENAMETOOLONG`——在 executor 之外——因此 `run()` 会 reject 而不是 resolve，违反了"只 resolve、不 reject"，并且由于只有 `settle()` 才会移除本次运行刚物化出来的暂存目录，它会把该目录留在磁盘上。现在 `spawn` 调用和 fd-3 收窄被包裹起来：一次同步抛出会移除暂存目录，并 resolve 与异步 `error` 事件所产生的同一类 `worker-exit`（`python spawn error: …`）。

### Stray pipe output is aggregated by line, not by transport chunk

同样在 `src/index.ts` 中，原生 stdout／stderr 字节（C 扩展写入、越过管道缓冲区的 `os.write`）过去每来一个 Node `data` 分片就被推入 `logs` 一条条目。`logs` 条目在下游（Code Mode）会用 `\n` 拼接，因此一次大于单次管道读取、且不含换行符的写入——它以若干个 `data` 分片到达——回读时会在任意传输边界处被插入模型可见的换行符。现在捕获会累积原始 `Buffer` 分片（与 fd-3 读取器同一形态，出于同样的原因：一个字符串 `+=` 累加器会为每个分片重新复制整份残余数据，而每个分片都从索引 0 扫描它则是第二重平方——在一次大的不含换行符的写入上二者都是 O(N²)），在原始的 `0x0a` 字节处切分，并为每个完整行准入一条条目。换行符绝不会出现在一个 UTF-8 多字节序列内部，因此对每个切出的行做解码无需流式解码器即可安全进行。三条相互独立的界限使残余数据不至于耗尽宿主内存，每一条都与 fd-3 读取器相对应：分片列表在越过 `MAX_PENDING_CHUNKS` 后会封存（SEAL）为已完成的块，因此一个以单字节 `os.write` 控速的程序无法累积起数以百万计的存活 Buffer 对象（其逐对象开销是任何字节计数都看不到的）；当两个管道合并（COMBINED）的持续推进序列化（SERIALIZED）开销——通过 `accrueStrayCost` 跟踪，它跨分片按结构解码 UTF-8，因此一个渲染为 U+FFFD 的字节会被计入该替换字符序列化后的三个字节——将要越过预算时，残余数据会被冲刷，因此一场控制字符或非法 UTF-8 的洪泛会在原始字节的一小部分处就冲刷，而不是先累积起满满一个预算份额的原始字节，并且 stdout 与 stderr 是合并计量的，而不是各自对照完整预算（那样会让两者同时各保留将近一个预算份额，使峰值翻倍）；而一旦账本已经截断，缓冲便停止，从而不会为永远无法被准入的输出累积任何内容。`accrueStrayCost` 按 U+FFFD 宽度对非法字节计费，正是针对一个从不作为合法序列开头的字节（0x80–0xC1、0xF5–0xFF）、一个在完成前断裂的多字节序列，或一个结构完整但非法（ILLEGAL）的序列的修复：`toString('utf8')` 会把其中每一个这样的字节都渲染为它自己的 U+FFFD（3 字节），因此它校验每个前导字节的首个后续字节范围（WHATWG：`E0`→A0-BF、`ED`→80-9F、`F0`→90-BF、`F4`→80-8F，其余为 80-BF），并对任何落在该范围之外的序列按每字节 3 计费。按原始的 1 计费会把一场 `b"\xff"` 洪泛少计三倍，而只按结构宽度计费同样廉价地把一个 CESU-8 代理项（`ED A0 80`）或过长编码（`E0 80 80`）少计三倍，让残余数据在冲刷前增长到满满一个预算份额的原始字节，并且在一个较大的 `maxLogBytes` 附近，在冲刷的 concat 加 `toString` 中膨胀到约 1 GiB 的峰值。被准入字符串的每条条目计费通过 `jsonStringCostUpTo` 按序列化开销计量，它把字符串走到上限即停止——先前的 `Buffer.byteLength(JSON.stringify(text))` 会先分配出整份转义后的形式，因此在一个较大的 `maxLogBytes` 之下，一行接近预算、控制字符密集的内容，仅仅为了度量它就可能瞬时分配超过一 GB。`jsonStringCostUpTo`（走字符串的那个函数，由一个伪造的、其文本经 `JSON.parse` 产生的 `log` 帧到达）给一个孤立（LONE）代理项计满六个转义字节（在 ES2019 良构 `JSON.stringify` 下为 `\uXXXX`），而不是 `Buffer.byteLength` 为其 U+FFFD 渲染所报告的三个字节，因此一场 `\ud800` 洪泛不会被少计一半；`accrueStrayCost` 走原始字节，从不把一个代理项当作代理项看到——一个 CESU-8 编码的代理项到达它时是三个字节，被它的逐前导字节范围检查所拒绝，每个计 3（共 9），与 `toString('utf8')` 所渲染的相符。该残余数据会在管道 `end` 时冲刷，也会在 `closeDeadline` 处理器销毁流之前被显式冲刷：一个持有管道不放的 `setsid` 逃逸者会迫使结算在没有 `end` 的情况下走那条路径，因此 leader 在退出前发出的最后一次不含换行符的 `os.write(1, …)` 否则会从 `logs` 中被丢弃。

### An incompatible output-budget/addressSpaceMb pair is rejected at load

子进程（[`py/bootstrap.py`](../../../../packages/code-runtime/code-runtime-python/py/bootstrap.py)）在 `RLIMIT_AS` 之下构建、计费并分帧一条 `maxLogBytes` 的日志条目或一个 `maxValueBytes` 的完成值，而两个账本都是按字符计数、对照一个序列化字节预算触发的。一个星芒面字符是一个字符，但占 CPython `str` 存储的四个字节以及四个 UTF-8 字节，因此一个预算份额的星芒面字符在构建出的字符串中约为预算的 4 倍，在为度量或发送它而取的 `encode` 副本中再约 4 倍，两者同时存活——峰值为预算的数倍。当一项预算逼近 `addressSpaceMb` 时，一次合法的、接近预算的输出会在那次构建加编码期间突破地址空间，并作为 `worker-exit`（日志）而不是截断而终止，或作为 `output-limit`（值）而失败。在运行时对每次子进程写入按地址空间计量是错误的修复：热路径上一次精确的序列化开销检查，要么是一次完整的 `encode`（正是要避免的那次分配），要么是一个逐字符的 Python 循环（它会烧掉 CPU 预算——一次 10 MB 的合法写入会在 `cpuSeconds: 1` 之下触发 SIGXCPU）。两者都是拿一种资源界限换另一种。取而代之，[`src/index.ts`](../../../../packages/code-runtime/code-runtime-python/src/index.ts) 在加载期（LOAD）拒绝这个不兼容的组合：每项预算乘以 `OUTPUT_BUDGET_WORST_CASE_ADDRESS_SPACE_MULTIPLE`（八——涵盖两份同时存在的约 4 倍副本加基线）必须放得进 `addressSpaceMb` 字节数，并用一个严格的 `>`，使得一项其最坏情况峰值恰好等于地址空间的预算也会被拒绝。`maxLogBytes` 和 `maxValueBytes` 都被对称地门控；值路径的构建加编码是同一形态。该检查在每个平台上都运行，而不仅在强制 `RLIMIT_AS` 的平台上：这种不兼容是那些配置值的属性，因此一个 Linux 部署无论由哪个宿主组装配置都会 OOM，而一致的加载期拒绝正是 fail-loud 契约（Darwin 仅跳过运行时的 `setrlimit`）。这在配置 seam 处消除了这一类问题，而不是给写入路径打补丁，因此 `_LogStream` 保留它原有的按字符计数的缓冲（一个对序列化开销有效的下界，一旦预算放进地址空间就是内存安全的）。

在此之外还一并修复了一处残余写入路径的复制，它与配置门控相互独立：`_LogStream.write` 的换行分支会在冲刷触发器能够对其设界之前，先把最后一个换行符之后整个未结束的尾部（`text[pos:]`）缓冲进 `_pending`，因此一个早出现的换行符后跟一个巨大的尾部（`"\n" + "A" * 30 MiB`）会对模型自身的字符串再做一份完整副本——正是这条路径存在所要规避的那次 `RLIMIT_AS` 死亡，而且是配置门控无法覆盖的一次，因为该尾部可能远超 `maxLogBytes`。现在该尾部被切到一个 `remaining + 4` 字符的前缀（超过 `remaining` 字符的任何内容都无法被准入，因为字符计数是序列化开销的下界），随后冲刷触发器会用标记将它拒绝。

## Testing

- `tests/boot-write-failure.spec.ts` 对 `spawn` 做 mock，使 fd-3 管道在引导写入时抛出异常（这是真实子进程无法被迫进入的唯一路径），并断言 `run()` resolve 出一个 `worker-exit` 而非 reject。一个同级用例让被 mock 的 `spawn` 同步抛出，并断言 `run()` 仍然 resolve 出一个 `worker-exit`，且会移除它的暂存目录——以被 mock 的 `spawn` 在其 argv 中收到的确切引导路径为准，因此一个同级 worker 的并发暂存不会让它变得不稳定。两者都被隔离在这个 spec 中，因此真实子进程测试套件不受影响。
- `tests/residual-detach.spec.ts` 对 `detachResidual` 做单元测试：向前传递的副本与残余数据相等、拥有一个大小与其自身长度一致的底层存储（fixture 保持在 Node 的 Buffer 池阈值之上），并且不与源帧的 `ArrayBuffer` 共享。
- `tests/runtime.spec.ts`：output-cap 用例断言 `ceiling - envelope` 上界（268435392）及其消息。一个 daemon 线程用例驱动四个线程穿过结算的 flush 发出未结束的写入。一个 native-write 用例在抬高后的 `maxLogBytes` 之下，通过 `os.write` 写入 200 KiB 且不含换行符，断言它回读时恰好是一条日志条目（证明散逸输出是按行聚合的，而不是在管道分片边界处被切开）；一个配套用例写入 `b"one\ntwo\nthree"`，断言得到三条条目（证明真正的换行符仍然起分隔作用）。一个 newline-free-flood 用例在一个 4 KiB 的 `maxLogBytes` 之下写入 2 MiB，断言捕获终止于截断标记且保持在预算之内（证明残余数据受账本约束，而不是被整体缓冲）；一个 NUL-flood 配套用例在同一预算之下写入 4000 个不含换行符的 NUL，断言发生截断（证明残余数据是按序列化开销计费的，约为原始的 6 倍，且在度量时不分配转义后的副本）；一个 illegal-UTF-8 用例在一个 3072 字节的预算之下控速发出单字节 `\xff` 写入，并对 `Buffer.concat` 做包装以度量峰值合并缓冲区，断言它保持在 2048 之下（按 U+FFFD 宽度 3 计费时残余数据在约 1024 原始字节处冲刷；一次原始字节的少计会让它达到约 3072，因此该界限具有区分力）；一个 CESU-8/overlong 用例把结构良构但非法的 `ED A0 80` 一次一个字节地控速发出，断言同样的峰值界限（按每序列真实的 9 计费时它提前冲刷；按结构宽度 3 计费会使峰值增至三倍，因此把逐前导字节范围检查回退会使它变红）；一个 broken-multibyte 用例在分开的分片里先写入一个 3 字节的前导字节、再写入一个新的 ASCII 字节，断言同时捕获到一个 `A` 和一个 U+FFFD（覆盖 `accrueStrayCost` 的跨分片断裂序列分支）；一个 post-truncation 用例写入一个 108 字节的载荷（小于最小的 PIPE_BUF，因此是一次原子写入），其首行耗尽一个 64 字节的预算，断言第二行被丢弃（覆盖单次 `data` 回调中的截断后准入空操作，无需 v8-ignore）；一个 short-escape 用例写入一行混合了制表符、引号、反斜杠、一个 `\uXXXX` 控制字符、一个多字节字符和 ASCII 的内容，断言它原样完成往返（覆盖 `jsonStringCostUpTo` 的每一条分支）；一个 reassembly 用例写入一个跨越每个合法多字节前导字节类别（E0 范围、普通 3 字节、F0 和 F4）、越过管道缓冲区的载荷，断言它原样完成往返且不含 U+FFFD（覆盖 `accrueStrayCost` 的逐前导字节范围与跨分片重组）；一个 lone-surrogate 用例在一个 4 KiB 预算之下伪造一个以 1000 个 `\ud800` 转义洪泛的 fd-3 `log` 帧，断言发生截断（该计数正落在计 3 字节会放行、计 6 字节则截断的窗口内，证明该代理项是按其完整转义宽度计费的）；一个 stray-sealing 用例在抬高后的预算之下控速发出 60000 次单字节、不含换行符的 `os.write(1, …)` 调用，并对 `Buffer.concat` 做包装以度量复制量，断言这股细流合并为一条条目、且累积复制量保持在一个实测的 256 KiB 阈值之下（封存后的形态复制约 120 KB，重新合并的形态复制约 538 KB，因此把封存回退成重新合并会使该断言变红——证明分片列表在越过 `MAX_PENDING_CHUNKS` 后封存为块）。一个 closeDeadline-flush 用例让 leader 写入一段不含换行符的诊断，随后 spawn 一个持有管道不放的 `setsid` 孤儿进程，断言该诊断在 `logs` 中存留下来（证明残余数据在截止时间销毁流之前被冲刷）。same-group 回收用例 spawn 一个忽略 SIGTERM 的同进程组后代，它释放管道并递增一个心跳文件；该测试断言在宽限窗口的 SIGKILL 之后心跳停止：无论被杀死的后代是被回收还是作为僵尸进程滞留，这个断言都成立，因此它在 PID 1 不 wait() 孤儿进程的环境下同样成立。一个 dispose-after-resolve 用例断言，对一个已完成、且存在同进程组存活者的运行调用 `dispose()`，只有在该存活者停止执行之后才返回（证明该运行会一直留在 `live` 中，直到它的进程组被回收），并带有一个 `expect(afterDispose).toBeGreaterThan(0)` 守卫，使得当心跳文件从未被写入时，冻结心跳的断言不会被空洞地通过。一个 deadline 用例忙阻塞事件循环越过两个定时器，断言该存活者的心跳冻结（证明轮询的截止时间分支自身发送 SIGKILL，而不是取消尚未触发的升级）。cross-loop 用例在主协程通过 `await asyncio.sleep` 让出时，从一个工作线程自己的 `asyncio.run` 事件循环运行一个绑定，断言该回复完成往返而不是超时；一个配套用例放弃某个线程的调用，使其事件循环关闭，随后在一个后续绑定之前回答它——断言 pump 在关闭事件循环上的 `call_soon_threadsafe` 之后仍然存活（由宿主门控的顺序使其具有确定性，未修复时会把后续绑定拖到墙钟上挂起）。inherited-soft-limit 用例通过一个 `ulimit -S -t` 包装脚本运行解释器，将 CPU 软限制设为低于 `cpuSeconds`，并断言实际应用的 `RLIMIT_CPU` 软限制是继承来的值，而不是配置的值（用 CPU 而非地址空间，因为 macOS 忽略 `ulimit -v`）。一个配套用例继承 1 秒的 CPU 软限制，让程序捕获 SIGXCPU 并忙循环越过它，断言结算复查报告 timeout——证明复查用的是实际生效的软限制，而不是配置的 `cpuSeconds`。一个 control-heavy-diagnostic 用例在一个较小的 `maxValueBytes` 之下抛出一个 NUL 洪泛异常，断言序列化后的帧能放得下（证明该诊断是按序列化开销计量的）。一个 output-budget/address-space 用例断言一个 50 MB 的 `maxLogBytes` 和一个 50 MB 的 `maxValueBytes` 各自对照一个 64 MiB 的 `addressSpaceMb` 在加载期被拒绝（乘以最坏情况的 8 之后超过地址空间），而默认的各项上限对照 512 MiB 则加载成功，对两项预算对称地门控。一个 non-integer-budget 用例断言一个小数的 `maxLogBytes`／`maxValueBytes` 在加载期被拒绝。

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

**按序列化开销对宿主侧的 `capMessage` 兜底做计费，与子进程的 `_cap_message` 相符。** 已否决：这两处上限守护的是不同的东西。`_cap_message` 的输出会作为一个 JSON 字符串再次穿过 fd 3，因此帧上限约束的是它转义后的宽度——那里必须按序列化计费。`capMessage` 的输出直接进入 `CodeRunResult.error.message`，绝不会再次穿过一个受帧上限约束的通道，因此对它所保留内容的诚实度量是模型可见字符串的原始字节长度。一个诚实的子进程已经按序列化开销设过上限，而原始长度 ≤ 序列化开销，因此一条格式良好的消息会原样通过；一条伪造的、控制字符密集的消息可能序列化到其原始长度约 6 倍，但由于它不经过任何受上限约束的通道，按那个被抬高的传输宽度对它计费只会截断一条尺寸合法的诊断，而换不来任何收束上的收益。每一侧的 JSDoc 都记录了这一区分，并指向另一侧。

**每来一个 `data` 分片就把散逸的管道输出推入一条条目。** 已否决：`logs` 条目在下游会用 `\n` 拼接，因此一个传输分片边界会变成一个模型可见的换行符——一次被拆散在多次管道读取中的原生写入会带着无端的换行回读。按真正的换行符聚合（原始分片缓冲 + 在 `0x0a` 处切分）与子进程的按行粒度的 `log` 帧相符；账本仍然通过在残余数据将要越过预算时把它准入并截断，来约束一场不含换行符的洪泛。

**逐帧强制 fd-3 帧上限（在计数器检查之前先切分）以避免一次批次边缘的误拒。** 已否决：帧上限检查在任何 `Buffer.concat` 之前读取字节计数器，正是为了让一个敌意程序无法迫使宿主内存达到 256 MiB 帧上限的约 2 倍（计数器与那次拼接是所持全部内容的第二份副本）。先切分以对单个帧计费，会在拒绝一个超上限的帧之前就 `Buffer.concat` 它，从而重新引入那种翻倍——正是出于这个原因，有两个回归测试断言了先计数后拼接的顺序。逐帧顺序本会修复的那次批次边缘误拒（一个合法的接近上限的帧，其携带换行符的分片同时也带上了下一帧的起始字节，在一次管道读取中把计数器推过上限）只有当 `maxLogBytes`／`maxValueBytes` 被配置到距 256 MiB 帧上限一次管道读取以内时才可达——比 32／64 KiB 的默认值高出好几个数量级。在任何配置下都抵御敌意输入的内存安全边界，优先于一个仅在病态的接近上限配置下才可达的误拒；计数器的超额计数与这一权衡都记录在该检查处。

**当合并预算被越过时，按残余数据到达顺序冲刷两个散逸管道。** 已否决：stdout 与 stderr 是相互独立的 OS 流，它们的 `data` 事件本就彼此之间、以及与子进程自己的 fd-3 `log` 帧之间不确定地交错。seam 的 `CodeRunResult.logs` JSDoc 写着「in order」，周围的文字把它限定为一条流之内的程序发出顺序——跨并发流的顺序在这里本质上是尽力而为，因为没有任何宿主侧的冲刷顺序能够重建内核已经丢失的真实交错，因此在冲刷处保留一条残余数据的到达顺序换不来任何东西。一个固定的排空顺序与任何顺序一样有效。跟踪一个逐残余数据的到达计次以先排空较早的管道，会增加一个分支，它的两侧只在两个 OS 管道的相对时机上才触发，而 `os.sched_yield` 并不使之具有确定性，因此该分支无法在不写一个不稳定测试的情况下被覆盖——有成本却没有可观测的契约收益。

**在运行时按地址空间对子进程日志账本计量，而不是在加载期拒绝该配置。** 已否决：对每次子进程写入做一次精确的序列化开销检查，要么是一次完整的 `encode`——正是一次超大写入负担不起、而账本那处廉价预检本就为规避它而存在的那次分配——要么是一个逐字符的 Python 循环，它会烧掉 CPU 预算（一次 10 MB 的合法写入会在 `cpuSeconds: 1` 之下触发 SIGXCPU）。每一种运行时做法都是在热路径上拿内存界限换另一种资源界限。地址空间的突破是 `maxLogBytes`／`addressSpaceMb` 组合的属性，而不是任何一次具体写入的属性，因此在加载期一次性拒绝这个不兼容的组合，能在没有任何逐次写入代价的情况下消除整类问题，并保留 `_LogStream` 原有的按字符计数的缓冲，它一旦预算放进地址空间就是内存安全的。

## Consequences

seam 的"只 resolve、不 reject"契约在引导写入路径和同步 spawn 失败路径上都得以成立，两者的覆盖率都是被度量的，且两者都不会遗留一个暂存目录。日志捕获是线程安全的，代价是每次写入和 flush 都要获取一次可重入锁，并且散逸的原生输出由它自己的换行符来分隔，而不是由传输分片来分隔。fd-3 残余数据的内存受实际保留的字节数约束，并且两个帧读取器都以一次而非平方级的方式扫描一个不断累积的帧。输出上限放行一个帧所能承载的每一个值，并在加载期拒绝一个非整数的预算。dispose 面对同进程组存活者是真正完全停稳的（以 `graceMs + 2 * CLOSE_REAP_MARGIN_MS` 为界，在进程组已为空时代价为零，并且一旦进程组清空就清除 SIGKILL 定时器，从而一次滞留的 kill 无法击中一个被回收的 pgid），RLIMIT 强制在 soft 和 hard 两者上都保持配置值与继承值中的最严格者（并且 SIGXCPU 诊断不再把一个宿主无法保证的预算说出来），并且从模型创建的线程调用的绑定会完成而不是超时，而且握手帧读取器不再在一个大程序上烧掉 CPU 预算。每处行为修复都附带一个在缺少它时会失败的测试，除了 Problem 一节点出的那三处——分块读取帧（一处系统调用次数的改进）、确认为空后的收尾（它唯一透过 seam 可观测的效应会在信号投递时冻结，而修复前的代码也会产生同样的结果），以及共享的 stdout／stderr 预算（它唯一透过 seam 可观测的差异取决于不确定的跨管道到达时机）——因此其余各处未来若发生回归都会变红。
