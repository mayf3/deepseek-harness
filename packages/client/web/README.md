# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

Web boot kernel: `new AppWebEntry(el, seams?).run()` mounts the client through two stages. The module stage claims the parser-preloaded `@deepseek-ai/dsh-client-modules` factory, builds its module system over the host-provided `window.__DSH_BOOT__` graph, adopts the queued runtime factory, and prefetches the `immediately` tier. The plugin stage mounts the vendored Cordis Loader, injects that module system through the Loader's `internal` interface, creates every graph entry, and waits for every fiber to become ACTIVE. It then hands the marked boot DOM to the dynamic UI renderer's `ctx.uiRenderer.mount(el)` operation; the renderer hydrates that DOM before switching to the complete UI. The host graph owns the roster, parser preloads, and prefetch marks; this package adds only the adopted modules bootstrap entry.

The boot page uses plain DOM and local CSS, so client-bundle and plugin-activation failures remain visible. Its fallback fonts and colors match the theme tokens that arrive during loading. Fiber updates retain one spinner node and grow its CSS arc as entries first become active; hydration preserves that node and its animation phase until the application commit. React mounting, slot rendering, application assembly, and browser-title projection live in [`ui-renderer`](../ui-renderer/README.md). Modules is the only package registered through `registerStatic`: its ordinary `lib/client.js` remains the graph row's artifact, but the kernel must claim and materialize that factory before the module system can load anything.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for shell-seeded shared modules. Together with `PRELOADED_CLIENT_EXTERNALS`, it defines the implicit external baseline for every dynamic bundle; `dsh.client.external` adds only exact non-baseline requests.

The optional override parameter `seams` forwards the module system's `loadBundle` transport override (`BootSeams`) for environments where external `<script>` execution cannot reach the page context; ordinary browser callers omit it.

## Model Experience

None, as the entry shell boots the browser plugin tree; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The application waits for the full roster** — one failed entry keeps the framework-free boot page visible with a per-entry report; partial UI availability is not supported.
