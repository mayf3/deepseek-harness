# `@deepseek-ai/dsh-sdk-minimal`

English | [中文](README.zh.md)

Standalone minimal SDK application bundle for `dsh --profile sdk-minimal`. Its single insert is the complete Cordis tree: SDK stdio startup and JSON-RPC serving, one environment-configured DeepSeek adapter, the executor-less agent spine, local subprocess and unrestricted filesystem providers, a persistent Bash PTY, the string-replace editor, and uncompressed JSONL session persistence under `$DSH_HOME/sessions`. It deliberately does not include [`dsh-base`](../base/README.md), Web, settings, managed credentials, telemetry, compaction, workspace instructions, skills, jobs tools, subagents, or any other model-facing tool.

The profile remains part of the ordinary launcher and layering model. The bundle supplies the complete default tree; the profile patch, home patch, and ordered `--patch` files can replace rows or insert external bundles above it. `dsh plugin --profile sdk-minimal` manages persistent dependencies. The shipped template uses startup-only patches so one stdio connection never observes replacement of its server or agent dependencies.

`DEEPSEEK_API_KEY` supplies the adapter credential. `DSH_MODEL` selects the sole configured model, `DSH_CONTEXT_WINDOW` sets its context window, and `DSH_SYSTEM_PROMPT` replaces the default persona. The process working directory is the sandbox-policy workspace and local-filesystem root. The bundle sets `danger-full-access`; its persistent shell and editor can modify any path available to the process.

## Model Experience

### Minimal coding-agent composition

#### What the model sees

The system prompt is `DSH_SYSTEM_PROMPT` or `You are a helpful software engineer assistant.`. The only advertised tools are owner-scoped persistent `bash` and `str_replace_editor`; runtime context, workspace instructions, skills, jobs controls, compaction, and Harness identity are absent.

#### Token effect

One stable persona plus the two tool schemas. Tool results and ordinary conversation history grow with the session.

#### KV Cache effect

Stable for a fixed persona, platform, provider, model, and bundle patch stack. Profile changes take effect on the next process.

## Known Limitations and Deferred Work

- **The profile is POSIX-only** — this layer uses a Bash PTY; Windows support belongs to the platform runtime layer above it.
- **The composition intentionally omits shared product services** — select `dsh --profile sdk` when settings, managed credentials, policy presets, telemetry, Web tools, or the full default tool roster are required.
- **User patches can expand the tree and corrupt stdout** — profile customization is trusted application composition; a plugin that writes ordinary text to stdout can break JSON-RPC framing.
