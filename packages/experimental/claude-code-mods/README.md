---
description: "Experimental bridge that loads Claude Code mods (hooks modules) and runs their hook chains on harness extension points, for users mounting a mod and maintainers extending the mapping."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-claude-code-mods

English | [中文](README.zh.md)

## Summary

Run [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview) inside agent runs: point `pluginDirs` at mod directories and their `register(on, options)` hooks guard tool calls, rewrite prompts, add commands and tools, and read session facts through the same `$`, `e`, `next` chain. Mounting costs nothing until a mod acts; each `$` call rides a composed harness service. Choose it to try an existing mod unchanged; it is an alpha interface-compatibility demonstration, so unserved events and `$` members fail with a message naming the gap, and nothing draws in the GUI.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package with the plugin directories to load, as `claude --plugin-dir` takes them. Each directory holds `.claude-plugin/plugin.json` and `hooks/hooks.json` with exactly one `modules` entry.

```yaml
- name: '@deepseek-ai/dsh-experimental-claude-code-mods'
  config:
    pluginDirs:
      - ./mods/token-weather
      - ./mods/blast-radius
    options:
      token-weather:
        history: 12
```

| Field | Default | Meaning |
|---|---|---|
| `pluginDirs` | required | Plugin directories in chain order; a relative path resolves against the process launch cwd |
| `options` | — | `register` option values by plugin name, overlaid on the manifest's `userConfig` defaults |
| `hookTimeoutMs` | `10000` | A hook's own running time per event (Claude Code's limit); time inside `next` or a `$` call does not count |
| `catchTimeoutMs` | `1000` | A `.catch` handler's running time |
| `processTimeoutMs` | `30000` | Default `$.process.run` and `$.http.fetch` timeout |
| `toolAliases` | — | Claude Code tool name → harness tool name entries added to the built-in table |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-claude-code-mods) is the exhaustive source for every accepted field.

### Which events your mod receives

| Event | Raised from | A hook can |
|---|---|---|
| `session.start` | `agent/created` of a root agent, awaited before its first turn; cancelling the creation abandons a waiting hook | observe; register commands and tools |
| `prompt.submit` | `agent/pre-step` with claimed messages; `e.text` joins the text blocks of the human's own (`user`-sourced) messages, and a rewrite touches only those | rewrite `text`, add `context` the model reads after the prompt, or `{ drop }` the prompt |
| `turn.start` | the first `agent/pre-step` of a turn | observe |
| `tool.call` | the `tools/execute` waterfall, after the harness permission decision; a call a mod raised with `$.tool.call` reaches only the mods loaded before it, attributed to the caller | observe before and after, `{ deny }`, answer with `{ result }`, or rewrite the result or its `isError` after `next` |
| `turn.complete` | the `turn/end` session event | observe; return `{ text }` for a line in the host log |
| `command.run` | a command the mod registered with `$.command.register` is typed | answer with `{ text }` or `{}` |
| `session.end` | `agent/disposed` of a root agent; `$.state` stays readable until the hooks settle | observe |
| `<namespace>.<method>` | a later-loaded mod's `$` call (`tool.call` arrives through the tool pipeline instead) | observe, rewrite, or `{ deny }` it |

`e.tool` and `tool` matchers use Claude Code's names where a harness tool has one (`Bash` ↔ `bash`, `Read` ↔ `read`, `Edit` ↔ `edit`, `Write` ↔ `write`, `Glob` ↔ `glob`, `Grep` ↔ `grep`, `WebFetch` ↔ `web_fetch`, `WebSearch` ↔ `web_search`, `Task` ↔ `subagent`, `TodoWrite` ↔ `todo_write`, `AskUserQuestion` ↔ `ask_user_question`, `ExitPlanMode` ↔ `exit_plan_mode`, `Skill` ↔ `skill`); every other tool keeps its harness name. Subagent events carry `e.agentId`. Every other Claude Code event name registers without error and never fires.

### Which `$` members your mod can call

| Namespace | Served | Over |
|---|---|---|
| `$.plugin` | `name`, `root` | the manifest |
| `$.ui` | `log`, `toast`, `status`, `invalidate`, `open`, `close`, `panes`, `ask` | `ask` on `ctx.userQuestions`; the others reach the host log, and `open` answers `{ isPlaced: false }` |
| `$.command` | `register`, `run`, `list` | `ctx.commands`, scoped to the agent whose event is running |
| `$.tool` | `register`, `call`, `list` | `ctx.tools`; a registered tool is named `mcp__<plugin>__<tool>` |
| `$.prompt` | `submit` | `agent.followup()`, framed as a message from the mod unless `asUser` |
| `$.session` | `id`, `cwd`, `root`, `model`, `turns`, `messages`, `usage`, `version` | the agent's Session and the `turnBoundary` and `contextPressure` projections; `cwd` and `root` both report the session workspace, the harness's one directory per session |
| `$.state` | `get`, `set` | memory held for the session, addressed by the `{ plugin, key }` a mod names |
| `$.store` | `get`, `set`, `delete`, `keys` | the `claude_code_mods` storage domain, one JSON object per plugin, 4 MiB |
| `$.clock` | `now`, `sleep`, `after`, `every` | timers the bridge cancels on unload |
| `$.fs` | `read`, `write`, `list`, `exists`, `stat` | `ctx.fs`, relative to the session workspace, 4 MiB per file |
| `$.process` | `run` | `ctx.subprocess`, argv without a shell |
| `$.http` | `fetch` | the process's `fetch`, bodies up to 4 MiB |
| `$.env` | `get`, `set` | this process's environment, shared by every session and plugin |

A call whose service is not composed rejects with the missing service's package name; a namespace or method outside this table rejects with `no implementation for <namespace>.<method>`.

### Test a mod

`createModTestKit` loads mods from directories or inline modules and raises events through them with stubs beneath, in the shape of `claude-code/testing`: `kit.on('tool.call', () => ({ result: 'ok' }))` answers in the engine's place, `kit.$.tool.call({ tool: 'Bash', command: 'ls' })` raises the event, and `mock.store(kit.on)` answers `$.store` from memory. The [test-kit specs](tests/testing.spec.ts) run Claude Code's own `first-mod` tutorial test against the fixture mod unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Loading

[`manifest.ts`](src/manifest.ts) reads and validates `plugin.json` and `hooks.json`; a directory that does not read as a mod fails the plugin load, because that is a deployment error. [`module.ts`](src/module.ts) imports the hooks module through Node with a per-load query so a reload evaluates it afresh, runs `register`, and collects each `on(...)` into a `HookRegistry`; `on` refuses an unknown event name and a second matcher-less registration of one event with Claude Code's wording. A module that fails to import or whose `register` throws is skipped with a warning and the session continues, as Claude Code does.

### The chain

[`chain.ts`](src/chain.ts) runs one event through the selected hooks, outermost first, with the engine behavior at the bottom. Each hook's `next` delegates beneath; a hook that throws, times out, or settles without a result object is skipped and reported once per failure kind, the result from beneath stands when it had already called `next`, and a `.catch` handler may answer in its place. The budget clock counts only the hook's own running time: it pauses inside `next` and inside every `$` call except `$.clock.sleep`. [`engine.ts`](src/engine.ts) owns the registry, per-session `$.state`, mod timers, and the two dispatch directions: an engine event reaches every selected hook, while a `$` call raised by one mod reaches only the mods loaded before it.

### Mapping onto the harness

[`index.ts`](src/index.ts) registers the listeners. `tool.call` runs around `tools/execute`, so the harness permission decision precedes the chain; a `{ deny }` becomes an error result with the reason, a `{ result }` for a mod-registered tool becomes a successful content result, and a `{ result }` for a built-in tool becomes an error-shaped result because a built-in tool's success value must satisfy its own output schema. A result a hook rewrote after `next` is installed as replacement content through `tools/post-execute`. [`host-ops.ts`](src/host-ops.ts) holds the engine behavior for each `$` call over `ctx.get(...)` services, so a deployment composes only what its mods use.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, mod loading, extension-point listeners |
| [`src/host-ops.ts`](src/host-ops.ts) | `$` behavior over harness services |
| [`src/engine.ts`](src/engine.ts) | Registry, `$.state`, timers, dispatch directions |
| [`src/chain.ts`](src/chain.ts) | Middleware chain, budget clock, failure rules |
| [`src/api.ts`](src/api.ts) | The `$` object a hook receives |
| [`src/module.ts`](src/module.ts), [`src/manifest.ts`](src/manifest.ts) | Hooks-module import and `on`; plugin-directory validation |
| [`src/matcher.ts`](src/matcher.ts), [`src/tool-names.ts`](src/tool-names.ts) | Event names, matchers, tool-name aliases |
| [`src/testing.ts`](src/testing.ts) | The test kit |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Claude Code mods reference](https://code.claude.com/docs/en/plugins/mods/reference) — the events, methods, and limits this bridge mirrors.
- [Experimental packages](../README.md) — publication policy and dependency isolation.
- [Hooks group](../../hooks/README.md) — the settings-hook bridges; a `hooks.json` that also holds settings hooks needs `dsh-hooks-claude-code` for them.
- [Tool execution pipeline](../../../docs/tool-execution-pipeline.md) — the waterfalls `tool.call` runs around.
- [Human commands](../../interaction/commands/README.md) — the registry `$.command.register` lands on.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt context and submitted prompts

#### What the model sees

Strings a `prompt.submit` hook adds to `e.context` arrive as one user message with source `{ kind: 'claude-code-mods' }` after the prompt; a rewritten `text` replaces the prompt's text blocks. `$.prompt.submit({ text })` queues a user message with the same source: the text alone with `asUser: true`, otherwise framed as below with the plugin name and the text filled in.

##### Framing of a prompt a mod submits

```markdown
Message from the "<plugin>" mod:
<text>
```

#### Token effect

No cost until a mod adds context or submits a prompt; that text is data-dependent, logged, and resent in later requests until compaction.

#### KV Cache effect

Append-only: added context and submitted prompts follow the reusable request prefix and do not invalidate existing entries.

### Tool outcomes a mod decides

#### What the model sees

A `{ deny: reason }` answer renders `Error: <reason>` as the tool result. A `{ result }` answer for a mod-registered tool renders the text as a successful result; for a built-in tool it renders the text as an error-shaped result. A result rewritten after `next` replaces the tool's content text. A dropped prompt ends the turn as `blocked` with no model-visible message.

#### Token effect

Denial and answered calls replace the tool's own output with the mod's text; a dropped prompt sends no request.

#### KV Cache effect

Tool results append after the reusable prefix; a dropped prompt invalidates nothing.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe where a Claude Code mod behaves differently through this bridge. They are current package constraints, not a task backlog.

- **No drawing surface** — `ui.render`, `ui.press`, `ui.input`, `ui.select`, `ui.resolve`, panes, the band above the prompt, and element trees are not served: `ui.render` hooks never run, `$.ui.open` answers `{ isPlaced: false }`, and `$.ui.log`, `$.ui.toast`, and `$.ui.status` reach the host log, not the transcript. The Web GUI slots that could carry them (`conversation.input.dock` for the band, `shell.overlay` for toasts, `conversation.composer.dock` for status, a log-only session event with a Chat node for log lines) exist but no client plugin renders mod trees yet.
- **Unserved events** — `tool.check`, `tool.describe`, `turn.step`, the other `prompt.*` events, `command.describe`, `config.*`, `session.compact`, `session.receive`, `session.send`, `session.append`, `session.attach`, `session.detach`, `session.measure`, `agent.*`, `plugin.register`, `engine.create`, and `telemetry.*` register and never fire; `classic.*` names are refused at `register` like any unknown event.
- **Unserved `$` namespaces** — `$.model`, `$.agent`, `$.config`, `$.settings`, `$.mcp`, `$.audio`, `$.telemetry`, `$.turn`, `$.ui.notice`, `$.ui.blit`, `$.ui.copy`, `$.fs.ancestors`, `$.process.spawn`, and `$.session.repo`, `send`, `append`, `authorize`, `compact`, `surfaces` reject with `no implementation`. `$.model.complete` waits on a logged side-request event so a mod's model call stays reconstructable from the Session log.
- **`tool.call` runs after the permission decision** — Claude Code runs mod `tool.call` hooks before its permission check; here the harness `tools/pre-execute` waterfall, including approval, settles first. Argument rewrites passed to `next` are not honored because the call's arguments are already logged; the bridge warns once per tool.
- **Answering a built-in tool** — a `{ result }` in place of a built-in tool's run reaches the model as an error-shaped result carrying the text, because a successful value must satisfy that tool's output schema.
- **One process, many sessions** — a mod's module-level variables and `$.env.set` writes are shared by every session and plugin in the process, where Claude Code runs one session per process; keep per-session values in `$.state`. `session.start` and `session.end` fire for root agents only.
- **No sandbox, no static analysis, no hot reload** — the hooks module runs in-process with Node's globals; the `$`-only access rule, `claude plugin validate`, type generation, `--plugin-dir` watching, and the in-session mod authoring flow are not implemented. A mod's `.ts` module loads only where Node strips types or the launcher transpiles.
- **`turn.complete` text** — the `{ text }` a hook returns reaches the host log, not a line under the answer; `durationMs` counts from the turn's `turn/start`.
- **`$.session.usage`** — `window` is `0` and `percent` absent until the route's context window and a provider usage report are known through the token meter; `rateLimits` is always empty. `$.fs.stat` reports `mtimeMs: 0`.
- **Settings hooks in `hooks.json`** — ignored with a warning; mount `@deepseek-ai/dsh-hooks-claude-code` for them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The next steps, in order of mod-author value: a `claude-code-mods/ui` session event and Client Chat node for `$.ui.log` lines, an `AbovePrompt` renderer over `conversation.input.dock` for `Box`/`Text`/`Button` trees, and `$.model.complete` over `ctx.llm` with a logged request event.

</details>
