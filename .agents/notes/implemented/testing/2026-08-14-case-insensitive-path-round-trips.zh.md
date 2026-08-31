# Agent Note: 测试期望值里的大小写不敏感路径往返

Status: implemented

[English](2026-08-14-case-insensitive-path-round-trips.md) | 中文

## 问题

[`packages/session/session-persistence-jsonl/tests/jsonl.spec.ts`](../../../../packages/session/session-persistence-jsonl/tests/jsonl.spec.ts) 有一条用例验证「定位 session 之前会先解析相对 `root`」。它传给插件的是 `relative(process.cwd(), absoluteRoot)`，而期望值由 `resolve(absoluteRoot)` 算出——同一个目录、两个不同的起点。

在大小写不敏感的文件系统上，这两个起点的拼写可能不一致。Windows 的 `path.relative()` 按大小写不敏感比较，返回的是去掉公共前缀之后的相对路径，前缀的大小写信息随之丢失；随后 `path.resolve()` 用 `process.cwd()` 重新拼出前缀。当 `tmpdir()` 与 `process.cwd()` 共有的那段前缀在两者中拼写大小写不同时，插件解析出的 root 带的是 `cwd` 那种拼写，而期望值带的是 `tmpdir()` 那种拼写，于是 `toEqual` 比较的是指向同一个文件的两个字符串。

当 `tmpdir()` 与 `process.cwd()` 共享一段路径前缀、但两者对它的拼写不同时，主机就处在这个状态——例如把 `TMP` 以一种拼写映射进 runner 工作树、而 workspace 路径用另一种拼写。仅仅落在同一目录树内并不够：若两者的前缀拼写相同，往返会得到同一个字符串。该用例只在那里失败、别处都通过，看起来像 flake，实际是两种拼写之间一个固定的分歧。

## 决定

期望值改为解析「插件实际收到的那个相对 root」。两侧都经过同一次 `resolve(cwd, relative)`，大小写不敏感的往返就不可能把两种拼写分别放到比较的两边。

这是只改测试的变更。平台把两种拼写视为同一个文件，所以存储行为不依赖 `resolve()` 产出哪种拼写。字符串本身仍可被观察到：hook 载荷以 `transcript_path` 携带它，shell 贡献者以 `DSH_SESSION_JSONL` 导出它，因此比较这些字符串的消费方仍能看出差异。组合 fixture（测试前置数据）如 [`apps/cli/tests/profiles/headless/tests/fixtures/cli.cordis.yml`](../../../../apps/cli/tests/profiles/headless/tests/fixtures/cli.cordis.yml) 就设置了相对的会话 root——但插件会先解析收到的值再使用，因此相对 root 落盘时只有一种拼写而非两种。

该用例仍然在验证它声称的东西：把插件的 `resolve(config.root)` 降级成 `config.root`（即不再解析相对 root）后，用例转红。

关于「用宿主的 `node:path` API 构造路径」这一相邻决策，归属的 note 是[跨平台测试前置数据](2026-07-22-cross-platform-test-fixtures.zh.md)；本 note 讲的是另一个机制——大小写不敏感文件系统上 `relative()`/`resolve()` 的往返。

## 考虑过的替代方案

**按大小写不敏感的方式比较两个路径。** 这能让受影响的 runner 上变绿，但等于把一个真实的配置分歧当成正常状态接受；而且这种写法会扩散到之后每一条路径断言，而不是留在唯一经由 `relative()` 往返的这一条里。

**重新注册 runner，让 `workFolder` 与目录大小写一致。** 这修的是底层的不一致，但 `.runner` 里同时存着 runner 的注册身份、pool 与 server URL，手工编辑有造成注册失配的风险；而且只要有别的宿主机的临时目录与工作目录大小写不一致，这条用例仍然是脆的。

**在期望值里用 `realpath()` 归一化。** `realpath()` 返回磁盘上的真实大小写，在这里就是 `cwd` 那种拼写，用例会通过；但它同时会解析符号链接，在临时目录本身是链接的宿主机上会改变该断言覆盖的内容。

## 后果

相对 root 那条用例现在只依赖 `resolve()` 本身，不再依赖两种拼写是否一致，因此在临时目录与工作目录大小写不一致的宿主机上也能通过。runner 注册本身未被改动：注册拼写与磁盘目录名不一致的状态会保持下去，所以今后任何拿 `tmpdir()` 派生的绝对路径去和 `cwd` 派生路径比较的断言，都会遇到同一个分歧。

改动后的用例通过，`session-persistence-jsonl` 整套 242 条用例通过。机制在非 Windows 环境用 `path.win32` 复现过：对同一目录的两种不同大小写拼写调用 `relative()` 会得到不含前缀的相对路径，`resolve()` 用 `cwd` 那种拼写重建，两个绝对字符串因此不同；把两侧拼写改成一致后，同一段代码即匹配。上面那条回归检查——把插件的 `resolve()` 去掉——在 fixture（测试前置数据）根与工作目录同盘符时会让用例转红。跨盘符时 `relative()` 返回绝对路径，两种拼写本就相同，该检查无法转红；本文件的 fixture 根来自 `tmpdir()`，所以只有该路径与工作目录同盘时该检查才会转红。
