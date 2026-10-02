---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-claude-code-mods-source

English | [中文](2026-10-02-claude-code-mods-source.zh.md)

## Summary

Adds the attribution-only `claude-code-mods` user-message source kind for context a Claude Code mod adds through `prompt.submit` and prompts a mod submits through `$.prompt.submit`.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-claude-code-mods-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "f4654f14522a5b84ae84e2d80959ea596c0684d04ca315bde3705261065a929c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "e4b8ca6005c0b20db2b7b9db5f1a46b2d5fb9ff1f6bad61c241512519bce8321"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "5163154425bd5e0d6b2617b7d3d9816ee04bd237a030decbbececac66a36c510"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "83e827b9ea6b4d7309bcf7f1f97040f4750d4ddaf5f19bf18e4cde7605c7e628"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. Readers preserve a `claude-code-mods` sourced message without the producer; no reader validates, replays, or authorizes on the kind, and the message text itself names the mod.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/claude-code-mods/tests: 88 tests passed, including the prompt-context and submitted-prompt source assertions in bridge.spec.ts.

<a id="dev-note"></a>
## Dev Note

None.
