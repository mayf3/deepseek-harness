# Python SDK 入门

[English](python-sdk.md) | 中文

本教程安装已发布的 Python SDK，运行检入的极简 profile overlay，并说明如何从自己的程序自定义同一个 `dsh` profile。

## 前置条件

- Python 3.10 或更高版本
- Git
- Linux x64、Linux arm64，或 arm64 上的 macOS 14 或更高版本
- DeepSeek 兼容的 API endpoint 与凭据
- 隔离的 workspace 与隔离的 Harness home

## 安装 SDK

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
python -m venv .venv
. .venv/bin/activate
python -m pip install deepseek-harness-sdk
```

安装内容包含匹配的原生运行时 wheel 与 `dsh` 命令。普通 SDK 运行不需要系统 Node.js。需要构建产物的仓库贡献者应使用 [Python 贡献者工作流](../../../python/development.zh.md)。

## 运行检入示例

导出凭据；使用兼容代理时再设置 endpoint：

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
```

使用显式 workspace 与 home 路径运行一个任务：

```sh
python examples/python-sdk-agent/minimal.py \
  --workspace /absolute/path/to/disposable-workspace \
  --dsh-home /absolute/path/to/example-dsh-home \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

脚本会打印最终 assistant 响应。所选 home 会保存生成的 `sdk` profile、设置、调用方添加的凭据、已安装插件，以及 `sessions/` 下的 Zstandard 会话日志。示例与 SDK 绝不会静默读取 `~/.dsh`。

## 在程序中使用 SDK

```python
from pathlib import Path

from deepseek_harness import DeepSeekHarness

workspace = Path("/absolute/path/to/disposable-workspace").resolve()
dsh_home = Path("/absolute/path/to/example-dsh-home").resolve()
patch = Path("examples/python-sdk-agent/minimal.patch.yml").resolve()

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cwd=str(workspace),
    dsh_home=str(dsh_home),
    profile="sdk",
    patches=(str(patch),),
) as harness:
    result = harness.run(
        "Inspect the repository and fix the failing tests.",
        session_id="example-001",
    )

print(result.final_response)
```

SDK 会延迟启动内置的 `dsh --profile sdk` 进程，并复用到上下文管理器退出。Profile、其持久 patch、home patch 与有序 `patches` tuple 共同组成应用配置。不存在独立 Python 运行时 bin 或完整配置选项。

## 安装或定义插件

需要在该 home 中持久保存依赖与 bundle 层时，使用 `dsh plugin`：

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh --profile sdk --dump-default-config >/dev/null
dsh plugin --profile sdk add file:/absolute/path/to/my-plugin-bundle
```

第一个命令初始化随附的 SDK profile。第二个命令把包管理转发给 `pnpm`，然后记录所有导出 `dsh.bundle` 层的已安装包。只有执行此管理命令时才需要安装 `pnpm`；启动已安装 SDK 不需要它。持久配置项变更应编辑 `$DSH_HOME/profiles/sdk/cordis.patch.yml`；单次启动变更则从 Python 传入 patch 文件。

另一个 `profile` 只有包含 `@deepseek-ai/dsh-sdk-app` 或另一个 JSON-RPC server 配置项时才有效。缺失 server 配置项、无法解析的插件和非法 patch 会在启动时失败，不会回退到其他组合。

## 理解极简 overlay

| 属性 | 值 |
|---|---|
| 系统提示词 | `DSH_SYSTEM_PROMPT`，未设置时为 `You are a helpful software engineer assistant.` |
| `minimal.py` 的模型 | `--model`，然后是 `DSH_MODEL`，最后是 `deepseek-v4-flash` |
| 面向模型的工具 | 仅持久 `bash` 与 `str_replace_editor` |
| Bash 超时 | 300 秒 |
| Editor 输出上限 | 16,000 字符 |
| 上下文压缩 | 禁用 |
| 会话持久化 | `<dsh_home>/sessions` 下的 Zstandard JSONL |

该 overlay 会为每个由 SDK 创建的根 agent allowlist 持久 Bash 与 editor，因此基础 profile 以后新增的工具不会隐式出现。它会抑制无关提示词段与运行时上下文消息，停用本地指令发现与 compaction，并保留 SDK 应用的协议、持久化、策略、settings、credentials 与 provider。持久 Bash 与 editor 可以修改运行时可见的任何路径，因此应使用一次性 checkout 或容器。由于采用 PTY 实现，本示例只支持 POSIX。

需要隔离 profile、插件、凭据、设置与会话时，应使用新的 home。独立工作应使用新的 session id；只有继续同一段持久对话和会话资源时，才同时复用 harness、home 与 id。

[示例参考](../../../examples/python-sdk-agent/README.zh.md)定义检入 overlay。[Python SDK 参考](../../../python/sdk/README.zh.md)介绍生命周期、结果、通知与底层行为；[dsh CLI 参考](../../../apps/cli/reference/README.zh.md)介绍 profile 分层。
