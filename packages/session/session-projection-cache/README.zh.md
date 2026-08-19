# @deepseek-ai/dsh-session-projection-cache

[English](README.md) | 中文

持久投影缓存（`ctx.sessionProjectionCache`）：把每个投影单元的状态保存为检查点，每会话一个 `projection_cache.json`，位于缓存自己的存储根下（`<root>/<session-id>/projection_cache.json`）。缓存拥有自己的目录树，绝不咨询持久化层。设计权威：[session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md)（persisted projection cache 一节）。

一条存储行 `(key → {ver, seq, val})` 是折叠捷径，绝不是权威：可能陈旧（`seq` 精确说明陈旧到哪），但绝不会错。实现据此承诺：

- **每次后台写入都 fail-soft。** 持久写失败只记一条警告并保持缓存陈旧；下一次写入自愈。两次写之间崩溃的代价是更长的尾部回放，绝不是错误的值。
- **`ver` 与当前运行单元的 `stateVersion` 不匹配即丢弃，绝不迁移。** 单元递增版本会在读取时使其行失效；该 key 从日志重新折叠。
- **存储行必须通过当前单元的 `stateSchema`。** 畸形文件读作"无缓存行"，冷路径从日志重新折叠。
- **整记录写入。** 每次写入原子替换该会话的缓存文件（注册表切面始终是完整的），并经无损 JSON 边界快照——违反纯 JSON 约定的单元状态会显式失败并报错。同一缓存文件的写入被串行化，新切面绝不会先于旧切面落盘。
- **记录绑定到日志生命周期，而不只是 id。** 每条记录存储其折叠来源的 header 身份（`createdAt`、`cwd`）；每次读取先以活 header 为证验证它，再接受任何记录——被删后重建的 id 无法让旧记录播种来自无关日志的状态。
- **日志领先，缓存跟随。** 活会话检查点先把缓冲事件持久 flush，缓存文件才落地，因此崩溃只会让缓存落后于日志（更长的尾部回放），绝不领先于它。
- **缓存自有目录树，默认私有。** 会话目录与缓存文件以仅属主权限创建（`0o700`/`0o600`）。缓存不依赖挂载的是哪个持久化后端——没有 `locate`、没有每会话目录探测。

## 写策略

两个必写点，其间节流：

| 触发 | 性质 |
|---|---|
| `turn/end` | 必写——列表读要的正是轮次终值。 |
| 会话释放（detach） | 必写——live 转 cold 的时刻；此后缓存服务该会话的最终切面。 |
| 累计 `writeEveryEvents` 个已提交事件 | 配置节流（条数）。 |
| 距首个脏事件 `writeIntervalMs` 毫秒 | 配置节流（间隔）。 |

`root` 与两个节流 `Config` 字段均必填（无默认值）：缓存根与写入节奏是部署选择，由 cordis.yml 明示。

## 列表读（`cachedSnapshot(meta)`）

每会话一次文件读取：从身份匹配的存储记录直接 view 客户端值（仅版本与 state schema 均匹配的 key），以 `{asOfSeq, values}` 切面返回——`asOfSeq` 取所服务行的最低水位，客户端在 higher-seq-wins 规则下播种值存储时，陈旧列表块永远压不过更新的推送帧。host-only 行永不返回。无可用客户端行（未知 id、无关生命周期、缺失或畸形文件、无可用行）时返回 `undefined`；api-proxy 列表载体将其转为列缺席。

`write(session)` 是两个必写点共用的同步切面检查点；载体可以直接调用（非 fail-soft——由 fail-soft 包装层负责遏制）。

## 组合

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    root: !!js dshHomePath('projections')
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

注入 `sessionProjections`、`sessions`。没有这一行时，投影系统只跑 live（水位缓存；冷读在实现了它的载体处退回全量日志加载）。

## 模型体验

无，因为缓存只持久化 host 侧的、由已写入日志的会话状态派生的读模型，不触碰任何提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；缓存从不组装或发送提供方请求。

## 已知局限与延后工作

- **不提供淘汰或保留接口**：记录会按会话持续累积；清理已存储的检查点属于带外维护，与会话持久化采用相同策略。
- **间隔节流采用按会话的粗粒度控制**：一次无脏数据的写入完成后，计时器会在首个脏事件到达时启动；对于持续但未达到条数阈值的事件流，系统每个间隔写入一次，而不采用滑动窗口。
- **缓存侧不做冷重折叠**——缓存只服务并刷新自己的文件，从不读取会话日志（不依赖持久化层）；需要保证冷快照的消费方自行从日志重折叠。
