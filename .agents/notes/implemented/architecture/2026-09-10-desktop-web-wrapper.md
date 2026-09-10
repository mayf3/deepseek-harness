# Agent Note: Run Desktop through the shared Web application

Status: implemented

English | [中文](2026-09-10-desktop-web-wrapper.zh.md)

## Problem

Separate Desktop composition and request transport require their own configuration, module loading, streaming, and asset-serving behavior. Those implementations can omit Web features even when the renderer is shared. Desktop needs its own installation and native controls without maintaining a second application backend.

## Decision

The private Desktop Host invokes the CLI's shared profile runner against the independently owned Desktop profile. The complete Web composition owns authentication, HTTP routes, client assets, RPC, and response streaming. Electron loads the authenticated URL reported by the child. Child IPC carries readiness and shutdown; application requests travel directly over HTTP.

The shared runner owns profile and Harness-home patches, proxy setup, telemetry defaults, module fallbacks, configuration reload, and application lifecycle. Web and Desktop share application mechanisms while owning their deployment defaults. Desktop uses a separate default listener port so both applications can run concurrently; profile configuration can override it. Native directory selection is a Desktop overlay with an observable UI purpose; shell windows, menus, plugin management, recovery, and updates remain Electron responsibilities.

The [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) retains separate runtime and plugin storage, bundled Node.js and pnpm, and explicit package ownership. The [in-place decision](2026-09-09-desktop-in-place-profile.md) retains package transactions and partial-failure recovery. The public CLI continues to reject the reserved Desktop profile.

This partially supersedes the private composition and portless transport in the [packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md). That design avoided listening ports and used framed byte pipes to avoid Base64 expansion and cross-version V8 serialization. Shared HTTP gives up the portless guarantee and assigns serving and authentication to the existing Web implementation. Release identity, signing, process ownership, and native shell features remain active decisions.

## Alternatives considered

**Maintain a second backend composition and carrier.** This permits a portless application, but every Web route, reload behavior, authentication change, and stream capability needs a Desktop implementation or explicit omission. Reintroduction requires a desktop product requirement that cannot use the Web implementation and justifies that continuing cost.

**Merge CLI and Desktop plugin installations.** Shared boot code does not require shared executable dependencies. Separate installations allow independently qualified releases and plugin versions while their existing data owners govern shared sessions and settings.

## Consequences

Desktop inherits Web features through the same boot and serving path. HTTP listener ownership and authentication remain part of application startup, and Electron must load the ready URL instead of assuming a port or translating requests. The independent loading and recovery window remains available before the Web application starts.

Verification requires shared-runner coverage, authenticated HTTP asset and API delivery, configuration reload, native directory selection, child shutdown, and recovery after plugin failure. Installed-platform and real-model GUI qualification remain distinct from unit tests; this note records no measured startup or transfer improvement.
