# @deepseek-ai/dsh-experimental-agent-team-web-profile

English | [中文](README.zh.md)

Private Web profile layer for Agent Teams. Apply it after `@deepseek-ai/dsh-web-app` and [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.md). The patch inserts the Team conversation-header UI; it does not modify the stable Web bundle.

From a source checkout, add both Agent Teams layers to an initialized Web profile:

```sh
pnpm dsh plugin --profile web add ./packages/experimental/agent-team-profile
pnpm dsh plugin --profile web add ./packages/experimental/agent-team-web-profile
```

The Host profile supplies the Team domain, generated Remote methods, and model tools. This Web layer mounts the generated Client Remote namespace and supplies the presentation. Removing either experimental bundle leaves the stable base and Web composition unchanged.

## Model Experience

Indirectly, through the Host-side Agent Teams profile selected alongside this Web layer.

#### KV Cache effect

No direct effect; the Host-side Team tools own prompt and schema changes.

## Known Limitations and Deferred Work

- **Ordered composition** — `dsh-base`, `dsh-web-app`, `dsh-experimental-agent-team-profile`, and this package must remain in that order.
- **Preset-scoped legacy controls** — stable Web presets still mount continuable Subagent controls inside the preset scope. Top-level Host profile overrides do not replace those scoped registrations, so the Team roster and legacy child controls can both appear until Web has a Team-aware preset.
- **Source-checkout only** — official CLI, Web, npm, and Python release payloads exclude this private package.
