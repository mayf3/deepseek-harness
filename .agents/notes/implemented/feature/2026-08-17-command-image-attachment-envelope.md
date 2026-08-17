# Agent Note: Command image-attachment envelope

Status: implemented

English | [中文](2026-08-17-command-image-attachment-envelope.zh.md)

## Problem

The Web composer submits one envelope — draft text, attached images, and delivery mode — but the two submission planes consumed it asymmetrically. A plain message rode `defaultSink → conversation.sendSession`, which serialized the images into prompt content and cleared them on success. A claimed slash command rode `claim.submit(args, actx)`, a text-only transaction: `/goal rebuild the cathedral` with four reference photos executed the command, cleared the draft, and silently stranded the images in the composer rail. The model never saw them, and no surface said so. The defect was contract-level, not a missed call site: nothing in the claim, the adjudication, or the host executor modeled attachments, so any command could consume the text half of a submission and drop the rest.

Merging the two planes was not on the table — the [plugin command registration Agent Note](2026-07-19-plugin-command-registration.md) deliberately keeps human commands out of the model plane, and that separation is correct. The gap was that the envelope fractured at the plane fork.

## Decision

The submission envelope is modeled end to end, and every command route either consumes it whole or refuses it loudly.

**Declaration.** `CommandDefinition.input.images: boolean` (absent = false) declares whether composer images may accompany an invocation. The flag rides the frozen `CommandDescriptor` through `commands/list` to every client, onto the minted `CommandClaim` (`images: true`), and into the input machine's published claim snapshot.

**Executor enforcement.** `CommandRuntime.execute(agent, line, images, signal)` carries the submission's base64 images (`EncodedImageAttachment` from `@deepseek-ai/dsh-attachment/types`). The executor — not the composer — enforces the declaration: images to a non-declaring command, an absent attachment store, and an exceeded batch limit each settle as a logged `command/done` error before the handler runs. Admission reuses the attachment package's `admitEncodedImages`, extracted from api-proxy's prompt path so both wire endpoints share one limits/validation/commit sequence and a rejected batch publishes no durable object. An admitted batch reaches the handler as frozen ordered `ImageBlock`s on `invocation.attachments`.

**Producer-owned model visibility.** The registry never schedules the images itself. `/goal` submits one `agent.followup` user message — image blocks plus the fixed text `Reference images for the goal objective.` — after a successful create or edit, so later goal rounds read the images from ordinary session history and the goal domain stores no attachment state. `/plan` folds the images into the message it already steers. Both producers reject sub-commands whose grammar has no carrier (`/goal pause`, bare `/plan`, `/plan off`) with a direct error, which keeps the composer's images in place.

**Composer refusal is a visible banner, everything retained.** ui-commands' `matchEnter` receives a `SubmitEnvelope` (image count) from adjudication and throws a localized `notice.imagesUnsupported` refusal for every enter route that cannot consume images: contribution popups, decorated popups, non-declaring claims, and bare detached executes. The input machine renders the rejection as one composer notice with draft and images untouched. A pre-claimed submit (space/menu claim) is gated in the facade with the same copy from the `conversation` namespace. On the accepting path the facade serializes the draft images through the hub's `commandImages` plumbing, passes them to `claim.submit`, and clears plus releases them only on a success outcome; an error result (including a producer grammar rejection) keeps them.

## Testing

Registry executor enforcement, admission failure settlement, and frozen invocation attachments are covered in `packages/interaction/commands/tests/commands.spec.ts`; batch admission ordering and limits in `packages/attachment/attachment/tests/admission.spec.ts`; producer behavior in `packages/goal/command-goal/tests/command-goal.spec.ts` and `packages/plan/plan-mode/tests/plan-mode.spec.ts`; client refusal and consumption paths in the ui-commands, ui-conversation, and ui-input-trigger client suites; and the assembled-application flow in the apps/web keyless lanes.

## Alternatives considered

- **Block commands whenever images are attached (no acceptance path)** — rejected: predictable, but `/goal` with reference images is the motivating use case; the user's images would have no route to the model at all.
- **Auto-send stranded images as a follow-up user message after any command** — rejected: surprising for host-state commands (`/model`, `/compact`), and it moves the message contract from the producer to the composer, against the command registry's "producer owns model-visible work" rule.
- **Store attachment references in the goal domain and render them into round prompts** — rejected: requires durable goal schema changes and either duplicates image blocks into every round prompt or adds round-one-only prompt shape; the round-prompt invariant would need attachment state. One ordinary logged user message achieves the same model visibility.
- **Consume images on any command success regardless of grammar** — rejected: `/goal pause` with images attached would silently discard them, recreating the original defect one layer deeper. Consumption is tied to the producer's explicit success, and grammar misfits return errors.
- **Keep enforcement client-side only** — rejected: schema omission is not enforcement; direct RPC callers could bypass the composer. The executor settles the declaration itself.

## Consequences

- No command route can consume a submission's text and strand its images: the contract forces whole-envelope consumption or a visible refusal, for current and future commands alike.
- The commands package now depends on `dsh-attachment` and `dsh-llm`, and `commands/execute` carries a required `images` wire parameter — every caller states its envelope explicitly.
- `/goal` and `/plan` gain reference-image input at the cost of one extra logged user message (goal) and image blocks in the steered message (plan), billed like any image prompt.
- Menu-pick popup flows do not consult the envelope: picking a popup command from the menu while images are attached leaves the images visibly in the rail rather than refusing the interaction. Enter-submission is the enforced envelope boundary.
