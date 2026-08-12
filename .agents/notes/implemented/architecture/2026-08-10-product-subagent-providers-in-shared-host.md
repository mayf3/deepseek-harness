# Agent Note: Product subagent providers live in the shared profile host

Status: implemented

English | [中文](2026-08-10-product-subagent-providers-in-shared-host.zh.md)

## Problem

The [Codex and Claude Code provider contracts](../feature/2026-08-04-claude-code-and-codex-subagent-backends.md) are independently installable packages loaded beside the common subagent tool. Agent Presets are the ordinary owner of one agent's model-visible tools, but a preset cannot safely own these product providers: `ctx.subagents` is a process registry, provider names are unique, and host consumers resolve the same registry across sessions. Bundle installation and Preset tool grant are therefore separate deployment and agent-authoring decisions.

The placement decision must preserve two independent facts. Loading a provider must not start or authenticate a product, while granting a tool must remain per preset so two sessions can expose different products. A global product switch, a provider instance per agent, or pre-enumerated combination presets would each create a second owner for one of those facts.

## Decision

When installed in a Profile, each product Bundle loads its fixed `codex` or `claude-code` provider exactly once in the shared Host plane. Loading either plugin only registers a dormant backend; the corresponding Codex or Claude process starts on the first actual delegation call. Agent Presets independently contribute ordinary `dsh-tool-subagent` rows for `subagent_codex` and `subagent_claude_code`, so a preset can grant neither tool, either one, or both without changing the provider registry. A tool whose provider Bundle is not installed remains unavailable rather than mounting another provider in the Agent plane.

The [production-closure decision](../simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.md) partially supersedes only this note's former default-inclusion choice: the base bundle excludes both providers, and each provider package owns its directly installable Bundle patch. This note continues to own process-wide Host placement whenever a product Bundle is installed. The provider-contract note continues to own each product protocol, result mapping, cancellation, process-tree lifecycle, and evidence tiers. The [Agent Preset architecture](2026-08-03-per-session-agent-presets.md) continues to own the Host/Agent split, preset authoring, and the rule that edits affect only newly composed sessions.

The providers use products already selected by the host environment. Codex starts `codex` from `PATH`; Claude Code resolves `claude` through the shared subprocess execution world and passes the exact path to the official SDK. Bundle loading does not install a product, create product state, probe a version, test authentication, or add product-specific settings. Missing commands and product failures remain local to the attempted delegation.

## Verification

Real composition loads the selected set of no product Bundle, Codex only, Claude Code only, or both, and crosses it with Agent Presets that grant none, either, or both tools. It proves the Host registry equals the installed Bundle set, model-visible tools equal the installed-and-granted intersection, and no product process starts during composition. Preset edit coverage retains generation isolation. Keyless ACP snapshots pin the model-visible tool schemas, while provider tests separately prove native executable resolution, failure, cancellation, and process-tree quiescence.

## Alternatives considered

**Keep both dormant providers in every base Profile.** This makes every matching Preset row immediately usable, but forces every production installation to carry both provider packages and the Claude Agent SDK even when neither integration is wanted.

**Store global or per-Profile product enable switches.** A process switch competes with the Preset as owner of model-visible tools and cannot express two sessions using different combinations. Availability and authentication are deployment facts, not another persisted product state.

**Mount a provider inside every Agent Preset.** Provider names belong to a process registry, so the second session would collide with the first. Host consumers also need the registry independently of any one agent's lifetime.

**Ship four product-combination presets.** Four identities duplicate complete compositions to represent two independent tool rows. Ordinary rows already express the full matrix without adding roster or maintenance state.

## Consequences

A user installs only the product Bundles available to a Profile and manages model-visible grants through the same Agent Preset authoring path as other plugins. Each new session receives the intersection of its preset's tool rows and the Profile's installed providers. An installed but ungranted product remains dormant and consumes its package and module-loading footprint but no product process, login, model call, or product home; an uninstalled product contributes no provider or SDK closure.

The Host registry remains the single provider authority, each Bundle remains the deployment availability authority, and each Preset remains the model-tool authority. This explicit two-gate lifecycle avoids a global enable switch and keeps package removal independent from per-session authoring.
