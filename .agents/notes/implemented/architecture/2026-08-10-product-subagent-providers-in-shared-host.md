# Agent Note: Product subagent providers live in the shared profile host

Status: implemented

English | [中文](2026-08-10-product-subagent-providers-in-shared-host.zh.md)

## Problem

The [Codex and Claude Code provider contracts](../feature/2026-08-04-claude-code-and-codex-subagent-backends.md) are separate packages loaded beside the common subagent tool. The Claude Code package is directly installable as a Profile Bundle, while a deployment mounts the Codex package explicitly. Agent Presets are the ordinary owner of one agent's model-visible tools, but a preset cannot safely own either provider: `ctx.subagents` is a process registry, provider names are unique, and host consumers resolve the same registry across sessions. Host availability and Preset tool grants are therefore separate deployment and agent-authoring decisions.

The placement decision must preserve two independent facts. Loading a provider must not start or authenticate a product, while granting a tool must remain per preset so two sessions can expose different products. A global product switch, a provider instance per agent, or pre-enumerated combination presets would each create a second owner for one of those facts.

## Decision

The Claude Code Bundle and an explicit Codex Host row each load their fixed provider exactly once in the shared Host plane. Loading either plugin only registers a dormant backend; the corresponding Codex or Claude process starts on the first actual delegation call. Agent Presets independently contribute ordinary `dsh-tool-subagent` rows for `subagent_codex` and `subagent_claude_code`, so a preset can grant neither tool, either one, or both without changing the provider registry. A tool whose provider is absent remains unavailable rather than mounting another provider in the Agent plane.

The [production-closure decision](../simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.md) partially supersedes only this note's former default-inclusion choice: the base bundle excludes both providers, the Claude Code package owns a directly installable Bundle patch, and Codex remains an explicitly mounted Host plugin. This note continues to own process-wide Host placement whenever either provider is present. The provider-contract note continues to own each product protocol, result mapping, cancellation, process-tree lifecycle, and evidence tiers. The [Agent Preset architecture](2026-08-03-per-session-agent-presets.md) continues to own the Host/Agent split, preset authoring, and the rule that edits affect only newly composed sessions.

The providers have different executable owners. Codex starts a host `codex` from `PATH`. The Claude Code Bundle installs its pinned Agent SDK and matching platform CLI; the provider lets that SDK choose the private native executable and passes the command through the shared subprocess owner without consulting or falling back to a host `claude`. Loading either provider only registers it and creates no product state, probes no version or authentication, and adds no product-specific setting. A missing Codex command or Claude platform payload, authentication failure, and other product failures remain local to the attempted delegation.

## Verification

Real composition loads either no Claude Code Bundle or the Claude Code Bundle and crosses that availability with Agent Presets that leave its tool disabled or grant it. It proves the Host registry and model-visible tools reflect those two decisions, no product process starts during composition, and Preset edits affect only later Sessions. Existing Codex Loader and provider tests separately prove explicit Host composition and host executable resolution. Keyless ACP snapshots pin the model-visible tool schemas, while provider tests prove SDK platform-payload selection without fallback for Claude Code, failure, cancellation, and process-tree quiescence.

## Alternatives considered

**Keep both dormant providers in every base Profile.** This makes every matching Preset row immediately usable, but forces every production installation to carry both provider packages, the Claude Agent SDK, and its large platform CLI payload even when neither integration is wanted.

**Store global or per-Profile product enable switches.** A process switch competes with the Preset as owner of model-visible tools and cannot express two sessions using different combinations. Availability and authentication are deployment facts, not another persisted product state.

**Mount a provider inside every Agent Preset.** Provider names belong to a process registry, so the second session would collide with the first. Host consumers also need the registry independently of any one agent's lifetime.

**Ship four product-combination presets.** Four identities duplicate complete compositions to represent two independent tool rows. Ordinary rows already express the full matrix without adding roster or maintenance state.

## Consequences

A user installs the Claude Code Bundle only in Profiles that need it, while a deployment that uses Codex mounts that Host plugin explicitly. Model-visible grants use the same Agent Preset authoring path as other plugins. Each new Session receives the intersection of its preset's tool rows and the Host's available providers. A present but ungranted product remains dormant and consumes its package and module-loading footprint but no product process, login, model call, or product home; an absent product contributes no provider closure.

The Host registry remains the single provider authority, the Profile Bundle or explicit Host composition remains the deployment availability authority, and each Preset remains the model-tool authority. This explicit two-gate lifecycle avoids a global enable switch and keeps package removal independent from per-session authoring.
