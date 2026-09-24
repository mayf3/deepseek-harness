---
description: "Configure Desktop product analytics, identity fields, and event timing without collecting Web usage."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-product-analytics

English | [中文](README.zh.md)

## Summary

Collect selected Desktop interactions through the existing OTel product exporter. The application can disable collection without a user-facing setting. Ordinary Web clients never submit these events, and missing login identity is omitted.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The Desktop launcher enables product analytics by default. Set `DSH_PRODUCT_ANALYTICS_ENABLED=0` in its launch environment to disable it on the next start; `1` enables it. Other values are rejected. This setting controls native welcome and upgrade events, renderer events, and Host compaction collection together. Disabled launches create no exporter, inspect no analytics identity, and retain no events for later enablement. Session-feedback telemetry has its own policy.

The shared composition supplies `enabled` (default `false`) and optional `appVersion` to this plugin. The Desktop Host enables it; an ordinary Web Host leaves it disabled. `DSH_PRODUCT_ANALYTICS_OTLP_URL` overrides the export destination for isolated collectors. The [exporter](../../host/product-telemetry-otel/README.md) owns batching, retry, and shutdown delivery.

Common fields are `device_id`, `user_id`, `os_version`, and `app_version`. Device identity reuses the existing login record without generating one. The Host reads credential-free device, account, and OS fields through `deepseekAccount.getDeviceIdentity()`. Missing values are omitted; API keys, account tokens, prompts, and responses are never event fields.

The desktop Host derives internal `DSH_DESKTOP_PRODUCT_ANALYTICS=0|1` from the validated launch switch. Electron supplies internal `DSH_PRODUCT_ANALYTICS_APP_VERSION` from its running version; an enabled exporter requires it. These variables belong to the Desktop launcher-to-Host protocol and are not Web opt-in controls. Desktop export, batch, and shutdown deadlines are 1000, 1500, and 2000 milliseconds, below the Host exit budget. Enabling collection without the exporter logs a configuration warning.

The [event types](src/events.ts) own names and allowed fields. Views count visible page entry, including reshown native welcome windows; transient onboarding loading does not repeat the same page impression, and closing an onboarding popup emits nothing. Funded Continue uses `next`. Message submission captures `submit_source`, `submit_type`, model, explicit effort, and `run_mode` before asynchronous command adjudication; only the default message sink reports, so handled commands are excluded. Programmatic submissions omit `submit_source`; keyboard and button gestures use `enter` and `click`. Plan takes precedence over an active goal. Capture and reporting failures cannot interrupt submission. A blank first-send Session has no `session_id`. Model and plugin switches report only accepted changes. Fork events carry the created child ID and the source IDs, before the optional child-title update; failed creation emits nothing.

Plugin rows use `plugin_type=plugin`, and packages use `bundle`. Installation reports `result_status=success|failed|cancelled|unknown` independently from `error_reason` and keeps `is_success`. Duration is milliseconds from the install click through the terminal result, including validation, inspection, and internal registry retries. `input_value` retains registry package identifiers and plain versions only; Git inputs become `[git]`, other URLs `[url]`, and paths or unrecognized inputs `[path-or-other]`. Both click and result use this redacted value. Reopening a hidden install dialog counts another `plugin_add_button_click`. `is_builtin` means installation-supplied (`installed=false`), not whether a profile explicitly depends on the package. Explicit build-approval retry starts a new attempt. Restart-required is success. A temporary disconnect retains the pending operation; only an absent recovery result becomes `unknown`.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Presentational components receive callbacks. Shared Client services resolve the optional Desktop analytics sender, which requires both the native preload marker and the Host's collection flag. Native actions use the authenticated Host API; its generated Typert validator accepts only the typed event fields. The Host enriches identity immediately before queueing. It observes live compaction events without replaying Session history. No runtime invariant companion is published because collection has no independent delivery acknowledgement to compare.

</details>

<a id="model-experience"></a>
## Model Experience

None, as analytics adds no model context or Session events.

#### KV Cache effect

None; collection does not modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Delivery is best effort.

- The switch is sampled at launch; there is no user control or live preference update.
- Renderer failures are discarded, and the exporter has no durable outbox or warehouse acknowledgement.
- Native startup reporting waits for Host authentication; a process that fails before Host readiness cannot report its launch.

### Dev Note

None.
