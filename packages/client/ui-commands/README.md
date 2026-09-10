---
description: "Client command API for the Web GUI: the / command source, three dispatch kinds, the per-session command directory, and popupSelect and action registration for business packages; for users and maintainers of slash commands."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-commands

English | [中文](README.zh.md)

## Summary

Typing a `/` command opens a registered popup, a client action, a host command's input, or direct execution; a command line is never silently downgraded to a plain prompt. Business packages register popupSelect specs (`/model`, `/permission`) or actions through `ctx.commandUi`, or decorate existing host commands with either kind while preserving their catalog rows and argument claims. Space and Enter resolve the line against the session's directory: a host descriptor with `input` is `leadingInput`, a registered `CommandUiSpec` is `popupSelect` or `action`, and everything else is `execute`.

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

Mount this plugin alongside `ui-input-trigger` and `ui-conversation`; the `/` source then appears in the trigger menu, and business packages register their command surfaces through `ctx.commandUi`. Typing `/model` opens the registered popup; a host command with an argument claim opens its input or executes directly. The composer's `+` button and a typed `/` open the same menu: an Add section (File, Goal, Plan, Feedback) and a Commands section (Compact, Permission, Model, Export) in usage order, each row with a glyph, a localized title and description, and the command name as an alias where the localized title differs from it.

### Kinds and decorations

A contribution is a client-owned command — a host-name collision fails loudly. Its UI is a popupSelect spec or an action: a callback a bare invocation runs after the trigger token is consumed, which submits nothing and therefore never refuses an attachment-carrying draft. The menu's File row is this package's own action; it opens the composer's file picker through the scoped `slash/input-pick-files` event wherever the composer accepts files, never on a subagent. A decoration adds a bare-invocation popup or action to an EXISTING host command: the host command keeps its catalog row, its argument claim, and its lifecycle logging, and a decorated name with no host row in the session's directory never fires. Menu queries fuzzy-match ordered, case-insensitive subsequences of command names and titles; prefixes rank first, and a typed query lists the matches flat without the section headings.

### Built-in row faces

Host descriptors carry English text only, so `src/client/presentation.ts` owns the client face of the six built-in Host commands: a catalog row whose description equals the canonical English text gets its localized title, description, glyph, and claim token from the `command` dictionaries, while a scoped override or third-party command of the same name keeps its own description and only its section position follows the name; rows outside both section lists close the Commands section in catalog order. Under Chinese, picking Plan fills the composer with `/计划 ` and the submission still executes `/plan `; a typed `/计划` or `/目标` resolves the same way on Space and Enter in every locale, so a draft written under one locale submits under another. Contributions supply their own `label`, `description`, and `icon`, read on every candidate pass, so a locale change reaches the next menu open without re-registration.

### Attachment-carrying submissions

When the composer submits with images or generic files, only a host command declaring `input.attachments` proceeds. Every other command route throws the localized `attachmentsUnsupported` refusal, rendered as a transient toast while the draft and attachment cards stay in place. Handler errors preserve the same draft state for retry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/client/contract.ts` is the fixed business contract: `CommandUiContract.register(name, spec)` and `decorate(name, spec)` are everything a business package consumes. `CommandDirectory` is the one wire-derived cache, keyed by session: ordinary sessions fetch through `command.list({sessionId})`, entries are soft-invalidated by the forwarded `commands/change` owner event and hard-invalidated by `connection/reset`, and epoch-guarded so a superseded pull can never overwrite a newer one. `matchSpace` answers synchronously from this cache only; `matchEnter` strong-waits it on the SubmitAttempt signal and rejects on warmup failure. After `command.execute` returns a matched result, the browser emits a local `command/executed` acknowledgment; other clients receive the durable command nodes through the Host event stream but never this acknowledgment. `PopupSelectController` is the headless shell state; `PopupSelectView` self-registers into `conversation.input.overlay` with per-session resolution. `presentation.ts` holds the section lists, the built-in row faces, and the localized-token resolution; `candidates` sections an empty query and ranks a typed one through the shared `rankByName`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the command surface is not enough. They move from the command API to the trigger pipeline and the host command registry.

- [ui-input-trigger](../ui-input-trigger/README.md) — the pipeline the `/` source registers into.
- [ui-conversation](../ui-conversation/README.md) — declares the input overlay slot and owns the composer.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the host `command.execute` RPC they trigger, each command handler's host package owns any model-visible effect (the `/plan` handler flips plan mode, whose owning package injects its policy section), while the command line, the detached result, and every menu and notice rendering stay client-side and never enter the session log.

#### KV Cache effect

None directly; this package neither assembles nor sends a provider request. Command handlers it triggers may change what the owning host packages contribute to the next request's system prompt — a section appearing or disappearing replaces earlier request tokens and invalidates the provider prefix from that point — but that effect is owned and documented by each command's host package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current command surface. They are current package constraints, not a general command-line comparison or a task backlog.

- **Detached-result notices fall back to the console off-session** — the fire-and-forget paths route results to the triggering session's composer via `SessionInput.notify`; after session teardown the console line is the only remaining surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This browser-side source uses the wire command directory; it emits no Cordis events and owns no cross-plugin mutable state. Its dispatch and cache behavior are asserted by this package's specs.
