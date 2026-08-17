# @deepseek-ai/dsh-client-render-service

English | [中文](README.zh.md)

The browser Cordis plugin that owns React mounting. [`dsh-client-web`](../web/README.md) renders a framework-free boot page and loads the complete client plugin roster; after every entry activates, it calls `ctx.appShell.mount(container)`. This package provides that service, installs the slot renderer, creates the React root, and returns its unmount disposer.

The plugin activates after `slots`, `sessions`, and `layout`. Its application tree projects the selected session title and performs the sole ctx-level `renderSlot('root')` call. React, React DOM, ui-slots, ui-primitives, and web-react retain one browser identity through the web shell's static module table; this package arrives as a dynamic client bundle.

## Model Experience

None. The render service assembles browser UI and contributes no model-visible input.

#### KV Cache effect

None; this package neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- **The first application frame waits for every client entry** — the boot kernel hands over the mount point only after the loader roster settles. Per-region readiness remains deferred.
