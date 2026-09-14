---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-12-browser-use-stagehand-llm

English | [中文](2026-09-12-browser-use-stagehand-llm.zh.md)

## Summary

Adds two log-only Session events that record Stagehand auxiliary model requests and completed model outputs without changing the Session format version.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-12-browser-use-stagehand-llm
baseline: false
changes:
  - root: "event:browser-use/stagehand-llm-request"
    previous: null
    after: "92cda1e2c0e9f57fdcd167a861b1296ec4cb5ac3ae127733c375e108335b32ac"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-result"
    previous: null
    after: "0e0e81784bc85e1e6554b7ff50ab341169a1a3d32149ae49abe8dddca5ce6efe"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session records remain valid because they do not require either new event. The events do not add conversation messages or restore browser state during replay. They retain the request sent through the selected Session model and its correlated output. Producers leave ignorable unset, so an older build that does not know these event names refuses the Session rather than silently discarding the inference record. No existing payload, header, envelope, or committed format generation changes.

<a id="verification"></a>
## Verification

`pnpm run gen-persistence-catalog` regenerated the installed event vocabulary and both persistence catalogs. `pnpm --silent run verify-persistence-changes --json` reported exactly two root-added changes with requiresVersionBump false. `pnpm exec vitest run packages/experimental/browser-use-stagehand-native/tests/model.spec.ts packages/experimental/browser-use-stagehand-native/tests/provider.spec.ts packages/experimental/browser-use-stagehand-native/tests/loader-composition.spec.ts` passed, including request/result logging and real Loader composition.

`pnpm run test:snapshot snapshots/sdk/sdk.snapshot.ts snapshots/session/headless.snapshot.ts -t browser-use-stagehand-native` passed both real-provider recorded scenarios. The Python SDK `sdk-snapshot` smoke passed against the built `dsh` executable; its projection fixture re-emits the recorded auxiliary payloads and checks exact retention in run events, subscriptions, and persistence, including request-sequence correlation and absence from model-visible messages.

<a id="dev-note"></a>
## Dev Note

None.
