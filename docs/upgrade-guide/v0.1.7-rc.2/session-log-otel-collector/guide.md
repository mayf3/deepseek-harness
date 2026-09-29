---
kind: upgrade-guide
description: "Feedback Session-log uploads go to a new collector host and require the @deepseek-ai/dsh-otel service."
---

# Session-log uploads use the shared OTel service and a new collector

## Change

In v0.1.7-rc.2, `@deepseek-ai/dsh-session-telemetry-otel` owned its own OTLP transport and sent feedback-authorized Session logs to `https://harness-telemetry.deepseeksvc.com/v1/logs`.

From the next release:

- The plugin injects the `otel` service from the new `@deepseek-ai/dsh-otel` plugin. `@deepseek-ai/dsh-base` mounts it as the `otel` row; a composition that mounts `session-telemetry-otel` without that row leaves the plugin inactive, and feedback uploads stop.
- The default collector is `https://dsh-otel-collector.deepseeksvc.com/v1/logs`. `DSH_TELEMETRY_OTLP_URL` still overrides it.
- Uploads are split into requests of at most 4,000,000 uncompressed bytes (`maxRequestBytes`).

Profiles that extend `@deepseek-ai/dsh-base` and networks with unrestricted egress need no action. Persisted Session formats are unchanged.

## Migration

1. If a custom composition lists `session-telemetry-otel` without `@deepseek-ai/dsh-base`, add the row before it:

   ```yaml
   - id: otel
     name: '@deepseek-ai/dsh-otel'
   ```

2. If an egress allowlist or proxy rule names `harness-telemetry.deepseeksvc.com`, add `dsh-otel-collector.deepseeksvc.com`. A deployment that points `DSH_TELEMETRY_OTLP_URL` at its own collector keeps its setting.
3. Confirm: send feedback with Session-log upload enabled and check that the configured collector receives the request; for a self-hosted collector, check its receive log.
