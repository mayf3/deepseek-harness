# @deepseek-ai/dsh-subagent-claude-code

English | [中文](README.zh.md)

This package registers the fixed `claude-code` subagent provider. Each accepted run invokes the official Claude Agent SDK in the delegating Session's workspace, lets the pinned SDK select its installed platform CLI, submits one self-contained text task, and returns only the final answer through the shared [`dsh-subagent`](../subagent/README.md) result contract.

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks and derives the child cwd from the parent Session. It creates one private `AbortController`, calls the official SDK `query()`, and publishes the run only after the SDK's `spawnClaudeCodeProcess` hook has supplied a live CLI handle owned by [`dsh-subprocess`](../../subprocess/subprocess/README.md). A failure or cancellation before publication closes the query, terminates any acquired process tree, waits for it to exit, and rejects `start()`.

The SDK receives the exact concatenated text task. The provider iterates the complete SDK message stream and accepts only a `result` message with `subtype: "success"`, `is_error: false`, and a nonblank `result`, followed by normal iterator completion. Every SDK error subtype, an error-marked success, a missing answer, iterator failure, protocol failure, or process failure maps to `error`; the provider produces neither `max-tokens` nor `refusal`.

Local cancellation wins the result race and maps to `aborted`. `dispose()` is idempotent: it aborts the run, asks the SDK query to close, invokes the shared process-tree termination escalation, and waits for whole-tree exit. SDK graceful close expresses protocol intent; the subprocess handle remains the authority for process quiescence. Result failure and independent teardown failure remain separate.

## Native settings and interaction

The provider deliberately omits the SDK `settingSources` option. The official SDK therefore reads the host's normal user, project, and local Claude settings relative to the parent Session cwd, including native account state and product configuration. The provider neither copies nor filters those files and does not create or modify login state.

Each query sets `persistSession: false` and disables `AskUserQuestion`. It supplies no `canUseTool`, elicitation, or dialog callback, so unattended interactions fail through the SDK instead of waiting for a user interface this provider does not own.

## Capabilities and context

The provider advertises no optional start-time capabilities and reports `inheritsParentContext: false`. Claude Code receives the standalone text task and the parent Session cwd, but not the parent conversation, persona, tool filter, depth policy, or structured-output contract. Every run has an independent SDK query, cancellation controller, CLI process, and non-persisted product session.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `env` | `{}` | Explicit SDK/CLI environment layered over the shared credential-scrubbed parent environment. |
| `disposeGraceMs` | `3000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md), between the shared process-tree owner's termination tiers; disposal then waits for whole-tree exit. |

Production omits `pathToClaudeCodeExecutable`, so Agent SDK 0.3.220 selects the matching native `claude` or `claude.exe` from its own platform package and passes that absolute command through the custom-spawn hook to `dsh-subprocess`. The provider does not inspect `PATH`, implement platform selection, or fall back to a host `claude`. Native settings and authentication remain authoritative. The plugin does not select a model, create a product home, log in, or probe an account. Credential-shaped ambient variables are removed before the explicit `env` overlay is applied, so an API key or token intended for the child must be supplied there. Non-credential endpoint variables such as `ANTHROPIC_BASE_URL`, along with ordinary ambient values such as `PATH` and `HOME`, remain inherited unless overridden; `PATH` does not choose the Claude executable.

This package is an optional Profile Bundle. Install it into the target Profile, then restart that Profile; installation brings the pinned Agent SDK and one compatible platform CLI payload into that Profile, while the declared `cordis.patch.yml` layer registers only the dormant `claude-code` Host provider and starts no Claude process. Removing the package withdraws that provider and its private runtime closure on the next Profile start.

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-claude-code
dsh --profile <name>
```

Installation controls Host availability, not model permission. Full Agent Presets carry the tool row below with `disabled: true`; copy a preset and remove that field to expose `subagent_claude_code` only to new agents composed from the copy. Its `one-shot` policy keeps omitted or `false` `run_in_background` calls in the foreground, while explicit `true` returns a parent-owned Job id for `job_output` or `job_kill`. The base Host and full presets already provide the generic Job registry and controls. The Profile's own patch can replace the Bundle row's complete `config`, while a custom Host composition can still mount the package directly.

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml (optional provider override)
- id: subagent-claude-code
  config:
    env:
      ANTHROPIC_API_KEY: !!js process.env.ANTHROPIC_API_KEY
```

```yaml
# A copied Agent Preset; remove `disabled` to grant this tool.
- id: tool-subagent-claude-code
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: claude-code
    toolName: subagent_claude_code
    backgroundMode: one-shot
    maxDepth: provider-managed
```

## Product compatibility and evidence

The runtime dependency is pinned to `@anthropic-ai/claude-agent-sdk@0.3.220`, whose eight platform packages carry Claude Code 2.1.220. A normal install selects one payload for the current OS, CPU, and Linux libc. For the current darwin-arm64 payload, `npm pack --dry-run --json` reports 74,858,812 packed bytes and 256,908,856 unpacked bytes; other platforms may differ, and these values are disclosure rather than an installation threshold. The keyless real-product test runs the SDK-selected CLI against a loopback Messages fixture and asserts that the shared subprocess argv begins with that platform package's native executable. Loader composition proves that installing the Bundle registers only the dormant Claude Code provider and starts no product process.

Installing with optional dependencies omitted, using an unsupported platform, or losing the selected payload leaves provider registration dormant but makes the first delegation fail with the SDK's native-payload startup error. The provider neither probes a host CLI nor retries with one.

The project owner's identity-scoped distribution authorization covers the official SDK and the official CLI/platform payloads declared by each SDK version. [`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md) discloses the current optional payload closure without classifying its declared terms as permissive; unrelated non-permissive runtime dependencies continue to fail the notices gate.

## Model Experience

### Child request

#### What the model sees

The Claude Code child receives the standalone text task as one fresh SDK query. Its workspace is the parent Session cwd, while its model, system instructions, tools, permissions, and authentication come from native Claude settings; the executable version comes from the Bundle's pinned SDK platform payload.

#### Token effect

The child pays for an independent Claude Code context and query. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on Claude Code's own model, instructions, tools, native settings, and fresh query.

### Parent scheduling and results, indirectly

#### What the model sees

Through `dsh-tool-subagent`, a foreground call gives the parent the strict final Claude Code answer or the consumer's exact error for a non-completed result. A background call first returns a Job id; the generic job controls later deliver a completion notice, expose the final answer and status through `job_output`, and let `job_kill` request cancellation. Claude Code reasoning, tool activity, intermediate messages, stderr, workspace diffs, usage, and product ids are not copied into the parent Session.

#### Token effect

Foreground input grows by the retained final answer or error. Background input also includes the start acknowledgement, completion notice, and any `job_output`, `job_kill`, or later status results; child tokens still do not enter the parent context. This provider adds no parent tool schema by itself.

#### KV Cache effect

Append-only: foreground adds one result after the reusable parent prefix, while background appends the Job acknowledgement, notice, and later control or collection results. Background scheduling can add a notice-driven turn, but none of these messages rewrites the earlier prefix.

## Known Limitations and Deferred Work

- **One fresh query and process per run** — there is no continuation, resume, pooling, progress stream, or product-session persistence.
- **Host settings are intentionally authoritative** — project and user settings can change model, tools, and behavior; the provider does not provide a filtered or hermetic production mode.
- **Authentication and account state remain native** — the Bundle supplies the CLI but does not create an account, log in, or rewrite Claude settings; configuration and authentication failures surface as startup or run errors.
- **The SDK platform payload is required at delegation time** — installs that omit optional dependencies, unsupported platforms, and missing or damaged payloads fail at the first query; there is no host-CLI fallback.
- **No human interaction path** — `AskUserQuestion` is disabled and other interactive callbacks are absent, so tasks requiring new approval or input fail instead of suspending.
- **Product payload is final text only** — reasoning, intermediate messages, tool traffic, usage, stderr, and workspace diffs remain product-local; generic Job ids, notices, and status come from the shared job runtime.
- **No optional shared capabilities** — output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider.
- **No wall-clock timeout or side-effect rollback** — the caller cancels long work, and files or external systems changed before cancellation are not restored.
