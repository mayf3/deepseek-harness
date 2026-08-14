# Agent Note: Production dsh excludes product subagent providers

Status: implemented

English | [中文](2026-08-12-production-dsh-excludes-product-subagent-providers.zh.md)

## Problem

`@deepseek-ai/dsh` receives the `@deepseek-ai/dsh-base` dependency closure. Including the Codex and Claude Code subagent providers there makes every production install download optional product integration code, including the Claude Agent SDK and its roughly 250 MB unpacked platform CLI payload, even when neither integration is used.

## Decision

This decision partially supersedes only the default-inclusion part of the [shared-host placement](../architecture/2026-08-10-product-subagent-providers-in-shared-host.md): `@deepseek-ai/dsh-base` does not depend on or mount the Codex and Claude Code subagent providers. The Claude Code provider package is a directly installable Profile Bundle whose `dsh.bundle.patch` points to one package-owned `cordis.patch.yml`. That patch contributes exactly one self-provider Host row and no Agent tool row. The Codex package remains available for deployments that mount it explicitly.

The two optional integrations remain independent. Codex continues to use a host `codex` from `PATH`. The Claude Code Bundle owns the pinned Agent SDK and the matching platform CLI selected from the SDK's optional dependencies; production uses that private CLI and never falls back to a host `claude`. Installing the Claude Code Bundle does not pull in the Codex package, and the default `@deepseek-ai/dsh` production closure contains neither provider, the Claude Agent SDK, nor its platform payloads. The Bundle registers a dormant provider on the next Profile start, while an Agent Preset independently decides whether a new Session receives its tool. Installation brings only the Claude Code package closure onto disk; it does not start a product, authenticate an account, rewrite native settings, or grant model access.

## Verification

Package tests pin the Claude Code Bundle manifest, published patch, exact self-provider row, and runtime closure. Claude coverage pins Agent SDK 0.3.220, Claude Code 2.1.220, all eight platform package identities and versions, the SDK-selected executable entering the shared subprocess owner, and first-delegation failure without host fallback when the payload is missing. Workspace validation derives each published patch from its Bundle declaration rather than a package catalog. Production-closure tests prove the default and Claude-only dependency boundaries, while real Bundle-patch and Agent-Preset composition covers absent and installed Host states, disabled and enabled tool grants, later-Session adoption, and zero product processes. Existing Codex package tests continue to cover explicit Host composition and host executable resolution. The base bundle test continues to reject both provider dependencies and configuration rows.

## Alternatives considered

**Keep dormant providers in the base bundle.** Dormant providers start no product processes, but their packages still enter every production npm install.

**Add a wrapper or meta Bundle.** A third package would duplicate installation ownership and make independent removal less direct without contributing another runtime capability.

## Consequences

Installing `@deepseek-ai/dsh` does not download either product provider through the base bundle. A Profile can add or remove the Claude Code provider Bundle directly; the changed Host availability takes effect on the next Profile start and explicitly accepts its SDK plus one large platform CLI payload. A Codex deployment still mounts that provider explicitly and supplies its product CLI through `PATH`. A separately authored Agent Preset grants either model-visible tool only to newly composed Sessions. No wrapper package, meta Bundle, dynamic installer, or persisted product-enable state is introduced.
