# Agent Note: Profile plugins share the installation's host runtime instances

Status: implemented

English | [中文](2026-09-18-profile-plugin-host-runtime-instances.zh.md)

## Problem

A profile resolves a bare specifier against its own `node_modules` before the installation. A plugin the profile installs out-of-tree therefore receives its own copy of every package it reaches through a `dependencies` edge, while the Host that loads the plugin keeps the installation's copy. Most packages tolerate that. `@deepseek-ai/dsh-scope` does not: it tags a scoped context with a module-local `Symbol('dsh.scope')` and keeps scope parents and event-carrier keys in module-local tables, and every registry that reads a tag — tool registration, prompt sections, MCP resources, scoped events — compares it by identity. A profile copy's `createScope` writes a tag the installation's `scopeOf` cannot read, so a registration meant for one Agent lands in the process-global layer.

Issue #4573 is that failure in production. While this package reached both runtimes through `dependencies`, a profile that mounted the Playwright MCP browser provider installed a second `dsh-scope`: the first Agent's MCP tools registered globally, the second Agent's tool synchronization collided, and `failOnStartupError: true` turned that collision into a rejected Agent creation. Matching the profile's package versions to the Host's did not change the outcome, because a duplicate exists at every version.

## Decision

An out-of-tree plugin package declares every host runtime whose cross-instance identity matters in matching `peerDependencies` and `devDependencies`, never in `dependencies`. Profile pnpm settings are `nodeLinker: hoisted` with `autoInstallPeers: false`, so such a peer is not installed into the profile and Node reaches the installation's single instance through the Harness home's module fallback.

`@deepseek-ai/dsh-scope` carries that identity through `createScope` as well as through the readers `scopeOf`, `carrierKeyOf`, and `scopeTarget`: the writer mints the tag its readers compare. `@deepseek-ai/dsh-mcp-client` joins it because its live `serverName` reservations are module-local, so a second copy keeps a second reservation table for the same namespace. `@deepseek-ai/dsh-experimental-browser-use-runtime` therefore declares both as peers with matching dev entries and keeps `@deepseek-ai/schemastery` as its only runtime dependency, which carries no instance-local state.

`tests/shared-host-runtimes.spec.ts` pins those sections for that package. `tests/host-runtime-duplication.spec.ts` reproduces what the rule prevents: one second copy of both packages puts each Agent's MCP tools in the global layer and rejects the second Agent's creation, while the shipped single-instance layout keeps the global layer empty and gives both Agents their own client.

The [published dependency faces](../process/2026-08-26-published-dependency-faces.md) note owns `verify-package-dependencies`: its `peerRequiredHostExports` table classifies the `dsh-scope` readers, and its package selection covers Client-faced packages and an explicit Host list. That gate selects no package under `packages/experimental/`, and it does not classify `createScope`; this note owns the rule for the out-of-tree plugin packages the gate does not reach.

## Alternatives considered

**Mount the MCP client on `agent.ctx` instead of a scope this package mints.** It loses because the profile copy's `scopeOf` also cannot read the tag the installation wrote for `agent.ctx`, so the `serverName` reservation degrades to the process-global owner and the second Agent fails at that check — the error form seen on `0.1.6-alpha.1`. Removing the duplicate is the repair for both forms.

**Make `dsh-scope`'s tag a `Symbol.for`, so two copies agree.** That fixes the tag lookup alone. Scope parents and event-carrier keys stay per copy, so the chain walk and carrier admission of one copy remain blind to links the other recorded — a smaller visible failure with a more confusing cause. It also keeps the duplicate that the profile never needed.

**Match the profile's package versions to the Host's.** Equal versions still load two module instances from two directories, so the defect survives it.

## Consequences

- A released fix reaches a profile when the plugin dependency is upgraded and reinstalled. An already-installed profile keeps its copies until then, and no Host-side change can repair it.
- The rule makes the plugin depend on the installation shipping the peer. Both packages are dependencies of the `@deepseek-ai/dsh` installation, so the fallback resolves them; a plugin outside the installation's closure would fail to load rather than start with a second copy.
- `docs/module-graph.md` renders these edges in its peer section, so the graph states the ownership boundary that the sections encode.
- Three sibling experimental providers (`browser-use-stagehand-native`, `computer-use-cua-driver-mcp`, `computer-use-cua-driver-native`) declare `@deepseek-ai/dsh-mcp-client` as a dependency. They mount no per-Agent MCP client, so this decision leaves them unchanged; giving one of them a per-Agent mount requires moving that declaration to peers first.
- `verify-package-dependencies` still selects no `packages/experimental/` package, so the sections of this package are pinned only by `tests/shared-host-runtimes.spec.ts`. Extending that gate's selection is the open coverage gap this note records.
