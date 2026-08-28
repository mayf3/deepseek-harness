---
description: "Package map for human collaboration and authorization: slash commands, one-shot approvals, permission presets, per-call Auto review, and questions that pause a running agent."
kind: "package-group"
---

# interaction/ — the human-collaboration plane

English | [中文](README.zh.md)

## Summary

The `interaction/` group is where a human collaborates with a running agent and where a deployment can authorize individual tool calls. It provides slash commands, one-shot approval decisions, named permission presets, the shipped Web's experimental same-model Auto review, and the question/answer service an agent pauses on when it needs a human decision. All six packages are product packages — the real interfaces a person drives or that enforce the selected interaction policy — and the product `dsh` CLI composes them directly. Interactive applications drive the command, approval, permission, and question interfaces directly, while automation uses the ACP transport. The subsystem references and package READMEs own the exhaustive contracts; this map points at each package and its neighbors.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package README and its subsystem reference own the exhaustive contracts.

| Package | Role | ctx key |
|---|---|---|
| [`commands/`](commands/README.md) | Lets users type slash commands that run directly against an agent without a model round trip | `ctx.commands` |
| [`user-approval/`](user-approval/README.md) | Asks composed answerers for one-shot allow/reject decisions and fails closed without one | `ctx.approval` |
| [`permission-presets/`](permission-presets/README.md) | Bundles sandbox mode with an approval policy into one user-facing Permissions selector | `ctx.permissionPresets` |
| [`auto-review/`](auto-review/README.md) | Reviews every Auto-mode native or PTC inner tool call with the current provider/model before execution | registers on `ctx.permissionPresets` and `ctx.tools` |
| [`user-questions/`](user-questions/README.md) | Defines the validated question schema and scoped answerer waterfall an agent pauses on | `ctx.userQuestions` |
| [`tool-ask-user/`](tool-ask-user/README.md) | Exposes the `ask_user_question` tool so the model can ask the human for a decision | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem references for the shared vocabularies, then the neighboring automation and composition surfaces.

- [Commands subsystem](../../docs/subsystems/commands.md) — command registry semantics and the `ctx.commands` cordis surface.
- [Approval subsystem](../../docs/subsystems/approval.md) — request/outcome vocabulary, the answerer waterfall, and per-session policy.
- [Permission presets subsystem](../../docs/subsystems/permission-presets.md) — the preset table and the knob write-through.
- [Auto review package](auto-review/README.md) — the five-section reviewer request, fail-closed decision, and lifecycle.
- [User interaction subsystem](../../docs/subsystems/user-questions.md) — question vocabulary, answerer waterfall, and presentation intent.
- [ACP group](../acp/README.md) — the automation-only transport that answers approval requests for its own agents.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
