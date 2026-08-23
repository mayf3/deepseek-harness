# python-sdk-agent

English | [中文](README.zh.md)

Runnable Python SDK example over the sole application launcher, `dsh --profile sdk`. The Python client owns JSON-RPC stdio; the profile owns the agent composition, persistence, permissions, and plugins.

## Run the minimal agent

Install `deepseek-harness-sdk`, export a model credential, then supply an isolated Harness home and workspace:

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
python examples/python-sdk-agent/minimal.py \
  --dsh-home /absolute/path/to/example-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

Set `DEEPSEEK_BASE_URL` for a compatible proxy, `DSH_MODEL` for the default model, or `DSH_SYSTEM_PROMPT` for the deployment persona. `--model` and `--profile` override their script defaults. The selected home stores the generated profile and Zstandard session logs under `sessions/`; the script never reads `~/.dsh` implicitly.

[`minimal.patch.yml`](minimal.patch.yml) is an ordered overlay on the shipped SDK profile. It preserves the SDK application bundle but narrows model-visible behavior to:

- owner-scoped persistent `bash`
- `str_replace_editor` with `view`, `create`, `str_replace`, and `insert`

The patch omits Harness identity and runtime-context messages, local instruction discovery, skills, compaction, plan/goal/task/web/subagent/workflow tools, and the profile's one-shot Bash. It inserts the local PTY and persistent Bash providers and sets the editor output limit to 16,000 characters.

This variant is intentionally POSIX-only. Its persistent PTY and editor can modify any path available to the runtime process, so use a disposable checkout or container.

## Add plugins

Use the runtime wheel's `dsh` command against the same explicit home for persistent profile changes:

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh plugin --profile sdk add file:/absolute/path/to/my-plugin-bundle
```

The Python call can also pass additional absolute patch paths in `patches=(...)`; later files win. A selected profile must retain `@deepseek-ai/dsh-sdk-app` or another JSON-RPC server row. Complete standalone Cordis files in this directory remain test fixtures for lower-level composition coverage; they are not Python SDK launch interfaces.

See the [Python SDK tutorial](../../docs/user/guide/python-sdk.md) and [SDK reference](../../python/sdk/README.md).
