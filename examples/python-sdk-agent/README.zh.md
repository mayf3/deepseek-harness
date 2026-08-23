# python-sdk-agent

[English](README.md) | 中文

基于唯一应用启动器 `dsh --profile sdk` 的可运行 Python SDK 示例。Python 客户端负责 JSON-RPC stdio；profile 负责 agent 组合、持久化、权限与插件。

## 运行极简 agent

安装 `deepseek-harness-sdk`、导出模型凭据，然后提供隔离的 Harness home 与 workspace：

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
python examples/python-sdk-agent/minimal.py \
  --dsh-home /absolute/path/to/example-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

兼容代理使用 `DEEPSEEK_BASE_URL`，默认模型使用 `DSH_MODEL`，deployment persona 使用 `DSH_SYSTEM_PROMPT`。`--model` 与 `--profile` 会覆盖脚本默认值。所选 home 保存生成的 profile，并在 `sessions/` 下保存 Zstandard 会话日志；脚本绝不会隐式读取 `~/.dsh`。

[`minimal.patch.yml`](minimal.patch.yml) 是随附 SDK profile 上的有序 overlay。它保留 SDK 应用 bundle，但将模型可见行为收窄为：

- agent 所有的持久 `bash`
- 支持 `view`、`create`、`str_replace` 与 `insert` 的 `str_replace_editor`

该 patch 会省略 Harness 身份与运行时上下文消息、本地指令发现、skill、compaction，以及 plan／goal／task／web／subagent／workflow 工具和 profile 的单次 Bash。它插入本地 PTY 与持久 Bash provider，并把 editor 输出上限设为 16,000 字符。

此变体刻意只支持 POSIX。其持久 PTY 与 editor 可以修改运行时进程可访问的任何路径，因此只应在一次性 checkout 或容器中使用。

## 添加插件

对同一个显式 home 使用运行时 wheel 提供的 `dsh` 命令，以进行持久 profile 变更：

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh plugin --profile sdk add file:/absolute/path/to/my-plugin-bundle
```

Python 调用也可以在 `patches=(...)` 中传入更多绝对 patch 路径；后面的文件优先。所选 profile 必须保留 `@deepseek-ai/dsh-sdk-app` 或另一个 JSON-RPC server 配置项。本目录中的完整独立 Cordis 文件仍作为底层组合测试 fixture；它们不是 Python SDK 启动接口。

另见 [Python SDK 教程](../../docs/user/guide/python-sdk.zh.md)与 [SDK 参考](../../python/sdk/README.zh.md)。
