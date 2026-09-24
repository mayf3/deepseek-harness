---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-21-user-question-reply

English | [中文](2026-09-21-user-question-reply.zh.md)

## Summary

Adds the qualified user-question-reply message source that carries a late answer or dismissal of a continued ask_user_question call into the agent inbox.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-user-question-reply
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "99a3e14f0b0ff0e38d345e7cb7d8d81ee8d11c51d611d9f91b1a82c8ea481fc4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "5d588f99e950c42bdd55a27fa41e98f5c86db5b0523622d85b99604c7ddb0107"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "64170a859320a56b572372f9ab16e31c4ae9c62454a31418e900ebbf90053c68"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "1d1697092d04c08f9fcb99015ac082e58b01b7de9e41611fa6aebf2879c3d083"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such source and remain valid. The kind is a qualified attribution: a reader without dsh-user-questions preserves the user message and its callId and outcome metadata unchanged and derives history from the message content alone. Only the producer's userQuestions projection reads the kind, to close the question it names; it imposes no validation, replay, or authority requirement. No event type is added and the Session header is unchanged.

<a id="verification"></a>
## Verification

pnpm run typecheck: Host and Client faces pass. pnpm --silent run verify-persistence-changes --json: the four affected roots classify as attribution-kind-added without a version bump. Projection and Remote behavior tests are pending.

<a id="dev-note"></a>
## Dev Note

None.
