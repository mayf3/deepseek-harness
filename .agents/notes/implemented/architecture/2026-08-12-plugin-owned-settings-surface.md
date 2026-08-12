# Agent Note: Plugin-owned settings surface

Status: implemented

English | [中文](2026-08-12-plugin-owned-settings-surface.zh.md)

## Problem

A plugin that registered a settings namespace could not reach the browser configuration page, and both gates that stopped it lived in this repository.

`packages/host/apiproxy` held two hardcoded namespace lists. `settings.describe` filtered its answer through them and every write checked them first, so a namespace outside them answered `settings-not-exposed` even when its owner had registered it. Adding a plugin to the configuration page therefore meant editing a package the plugin author does not own.

The plugin configuration section rendered an unordered list of whatever cards were registered into `settings.plugin.item`. A card carried an opaque `id`, never the namespace it edited, so the section could not tell which served namespaces already had a home. That left every question about "who renders this namespace" unanswerable from the ledger the section could see.

Together the two meant a user-authored plugin was configurable only by hand-editing `settings.yaml`. The [web plugin configuration note](../feature/2026-08-10-web-plugin-configuration.md) recorded the allowlist as deliberate, and the [config-plane boundaries note](2026-07-30-config-plane-boundaries.md) tied web-configurability to membership in the configurable-provider directory. Both conclusions blocked exactly the plugin authors the general seam was built for.

## Decision

**Registering is exposing.** The api-proxy serves every namespace `ctx.settings.describe()` returns and gates no write. `WEB_SETTINGS_NAMESPACES`, `PRODUCT_SETTINGS_NAMESPACES`, the union with `ctx.llm.listConfigurableProviders()`, and the `settings-not-exposed` error code are gone. A name no registration answers — unknown, or malformed and therefore unable to address one — folds into the seam's own `settings-rejected`, so the proxy contributes no boundary and no vocabulary of its own.

**The settings seam is untouched.** Which client may read a namespace, and which page renders it, are facts about consumers; a Service Definition that carried either would let one Consumer dictate its contract. `SettingsRegisterOptions` gains nothing.

**`settings.plugin.item` is keyed on the settings namespace.** The slot moved from `list` to `keyed`, the key being the namespace the card edits, following the `tool.call.toolview` precedent where each tool plugin registers its renderer under the tool name. A card declares `key`, not `id`/`order`.

**The section drives dispatch from the served namespaces.** It reads `settings.describe` once, subscribes to the settings-document invalidation and to connection resets, and dispatches one key per served namespace. What renders is the intersection of two ledgers — namespaces a live Host plugin registered, and cards registered under those keys — computed in the section's controller from the slot ledger (`ctx.slots.entries`, `ctx.slots.subscribe`) and the wire answer.

Keying makes absence the signal, and that is what removes the bookkeeping the previous shape needed. A namespace another surface owns (`ui-theme`, `permission`, `llm-*`, `agent-presets`) has no card under its key, so it renders nothing without declaring anything anywhere. A card whose namespace this deployment does not serve is never dispatched, which also fixes the old empty-state defect: the section counted registered cards, including ones rendering nothing, so a deployment exposing none showed an empty list instead of its empty line.

**Nothing renders a form it was not given.** The section supplies no fallback card. A plugin's browser half owns its card completely — chrome, controls, and copy — which is what the slot's `fallback` option would have replaced with a schema-reverse-rendered form.

## What the allowlist protected

The removed gate was not the boundary it read as. Every `settings.*` method sits in `PRIVILEGED_METHODS` (`packages/client/connection`), so a non-loopback or cross-origin request is refused with 403 before reaching this code; `role('secret')` fields are structurally stripped from every layer of every response; and the document the plane edits is the user's own `settings.yaml`. The read the gate blocked was already available to the same browser through the plugin inventory page, which lists every mounted plugin with its effective configuration. The writes it blocked were the least consequential ones on the plane: `permission` (which can widen the approval preset) and `agent-presets` (which decides what a session mounts) were both already served.

The one namespace whose exposure actually changes is `agent-default-model`. It has no browser half, so nothing renders it.

## Alternatives considered

**A declaration on `settings.register()`** (`client: { surface: 'plugin-config' | 'custom', title, description }`), which the removed `WEB_SETTINGS_NAMESPACES` comment named as the intended direction. It keeps registration from crossing the transport by default and lets a plugin author self-serve in one line. Rejected because `surface` is browser-page vocabulary and `title`/`description` are presentation: a Service Definition carrying them is a seam shaped by one Consumer. Its fail-closed property is also worth less than it reads — see what the allowlist protected, above.

**A separate exposure catalog**, a registry of its own that plugins join beside their settings registration, generalizing `ctx.llm.registerConfigurableProviders()`. Rejected because it makes one fact require two registrations that can drift: registering a namespace and forgetting the catalog entry produces a section nothing can edit, with no gate able to see the mistake.

**A deny-list `Config` field on the api-proxy**, so a deployment could withhold a namespace. Rejected for having no consumer: every currently registered namespace is one a user may edit, and a genuinely sensitive field is answered per-field by `role('secret')`, which is the finer instrument. A namespace-wide switch invented ahead of its first use is the speculative option the package rules forbid.

**A schema-driven generic card as the slot's `fallback`**, so a plugin with no browser half still got a form from `schema.toJSON()` (schemastery already carries `description`, `role`, `min`/`max`/`step` and serializes them). Rejected because client plugins load at runtime from mounted Loader entries, so a plugin author can ship a real card, and a reverse-rendered form was already judged worse than a hand-written one for the Models page. The `fallback` option remains available without a contract change if that judgment changes.

**A client-side claim registry**, where each surface owning a namespace declares it so a generic card knows what is already covered. Rejected with the generic card: keyed dispatch already makes an unclaimed key render nothing, so the registry would restate what the slot ledger says.

**Keeping the list slot and adding a namespace field to its options.** Rejected because the section would still enumerate entries rather than namespaces, keeping the empty-state defect and leaving a card for an uncomposed plugin to suppress itself.

## Consequences

A plugin distributed outside this repository is configurable from the settings page with no change here: it registers its namespace on the Host and its card under that key in the browser, and the section pairs the two. Cards now appear in card registration order rather than by hand-assigned `order`; the Host's description order is deliberately not the display order, because plugin activation can reorder it between boots and a settings page whose cards move between visits is worse than one whose order a registrant chose.

The wire read the section adds is one `settings.describe` beside the per-scope reads the cards already make. Its invalidation is imprecise in one direction: the wire announces document commits and connection resets, not registrations, so a namespace registered after the section's read joins on the next commit or reconnect.

Two frictions remain for an author outside this repository, both recorded in the section's README. The browser half must be a `dsh.client` package built in the client module system's lazy-CJS factory format, and the `clientBundle` preset that emits it lives in `packages/client/tsdown.client.ts` rather than a published package. The bundle-purity gate forbids importing this package's card chrome or staged-form model as values, so such a card reimplements staging and revision fencing. Sharing them would mean either publishing the preset or declaring a child slot inside the card so the section supplies the chrome; neither is built.
