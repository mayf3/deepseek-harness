# Agent Note: Production dsh excludes product subagent providers

Status: implemented

English | [中文](2026-08-12-production-dsh-excludes-product-subagent-providers.zh.md)

## Problem

`@deepseek-ai/dsh` receives the `@deepseek-ai/dsh-base` dependency closure. Including the Codex and Claude Code subagent providers there makes every production install download optional product integration code, including the Claude Agent SDK, even when neither integration is used.

## Decision

This decision partially supersedes only the default-inclusion part of the [shared-host placement](../architecture/2026-08-10-product-subagent-providers-in-shared-host.md): `@deepseek-ai/dsh-base` does not depend on or mount the Codex and Claude Code subagent providers. Each existing provider package is instead a directly installable Profile Bundle whose `dsh.bundle.patch` points to one package-owned `cordis.patch.yml`. That patch contributes exactly one self-provider Host row and no Agent tool row.

The two Bundles remain independent. The Codex Bundle owns its `@deepseek-ai/dsh-sdk-protocol` runtime dependency; the Claude Code Bundle owns its Agent SDK runtime dependency. Installing one does not pull in the other, and the default `@deepseek-ai/dsh` production closure contains neither provider nor the Claude Agent SDK. An installed Bundle registers a dormant provider on the next Profile start, while an Agent Preset independently decides whether a new Session receives the corresponding tool. Installation does not start, authenticate, configure, or grant model access to either product.

## Verification

Package tests pin each Bundle manifest, published patch, exact self-provider row, and product-specific runtime dependency. Workspace validation derives each published patch from its Bundle declaration rather than a package catalog. Production-closure tests prove the default, Codex-only, and Claude-only dependency boundaries, while real Bundle-patch and Agent-Preset composition covers all four installed sets, the full tool-grant matrix on a Host with both providers, representative missing-provider cases, and zero product processes. The base bundle test continues to reject both provider dependencies and configuration rows.

## Alternatives considered

**Keep dormant providers in the base bundle.** Dormant providers start no product processes, but their packages still enter every production npm install.

**Add a wrapper or meta Bundle.** A third package would duplicate installation ownership and make independent removal less direct without contributing another runtime capability.

## Consequences

Installing `@deepseek-ai/dsh` does not download either product provider through the base bundle. A Profile can add or remove either provider package, or both, directly; the changed Host availability takes effect on the next Profile start. A separately authored Agent Preset still grants the model-visible tool only to newly composed Sessions. No wrapper package, meta Bundle, dynamic installer, or persisted product-enable state is introduced.
