# Agent Note: Consistent Trajectory attachment presentation

Status: proposed

English | [中文](2026-09-15-trajectory-attachment-presentation.zh.md)

## Problem

A user message can contain text, images, and ordinary files, but Trajectory exposes different subsets of that message across its ledger and inspector. The [ledger projection](../../../../packages/client/ui-trajectory/src/client/layout.ts) omits the image count when text is present. The [inspector renderer](../../../../packages/client/ui-trajectory/src/client/TrajectoryTable.tsx) displays images without ordinary file cards in Preview and mixes file JSON with rendered images in Raw. Readers cannot reliably identify the complete attachment set without switching views.

The Summary tab embeds `MarkdownRecordContent` with compact presentation, while Preview uses the same component without that option. Attachment changes must preserve that shared renderer so both entry points expose the same content and actions.

## Proposal

Deliver one Trajectory presentation change covering the ledger, Summary, Preview, and Raw. The proposed behavior is not implemented by this document; Issue #4356 and its linked PR track execution status and completed evidence.

### Display behavior

| Location | Proposed behavior |
|---|---|
| Ledger | Show separate nonzero image and ordinary-file counts beside the text excerpt, including messages that contain text. Keep each record on one compact line. |
| Summary and Preview | Render the message text followed by one ordered attachment list. Use the same attachment renderer in both tabs; Summary may retain its compact spacing and scroll container. |
| Attachment list | Use equal-width compact rows with consistent height, spacing, and corners. Place a file-type icon or contained image thumbnail on the left and the recorded name and available metadata on the right. Preserve attachment occurrence order, including repeated references. |
| Image interaction | Fit the whole image inside its thumbnail without cropping. Open the existing large-image viewer on activation; preserve keyboard access, loading feedback, and retry after a failed read. |
| Raw | Preserve original content-block order and boundaries. Give image and file blocks consistent, initially collapsed metadata disclosures, with complete recorded fields available on expansion. Keep text blocks as unrendered text; generated display labels do not become raw fields. |

Use the recorded filename when available and a localized numbered image label otherwise. Show type and size only when supported by the recorded data; preserve zero-byte sizes. Long names may truncate visually, but the full name must remain available through accessible text and a tooltip. A message without text still exposes every attachment. Multiple attachments remain reachable inside the inspector's existing scroll area.

### Implementation ownership

[ui-trajectory](../../../../packages/client/ui-trajectory/README.md) owns the counts, ordered attachment projection, and inspector composition. Carry typed image and file references through its view data rather than recovering file metadata by parsing JSON prepared for display. Keep complete recorded attachment fields available to Raw.

[ui-attachment](../../../../packages/client/ui-attachment/README.md) retains image loading and viewer behavior, using the Conversation-owned per-session cache. Compose cross-package UI through slots and reuse suitable static controls from [ui-primitives](../../../../packages/client/ui-primitives/README.md), following the [client rules](../../../../packages/client/AGENTS.md). Update all consumers of any changed shared props. Keep the containment treatment specific to the requested attachment presentation so existing Chat and tool-image sizing remains covered by regression checks.

This scope uses existing durable attachment references. It introduces no upload, storage, model-request, or Session-format change, and no ordinary-file content viewer or download action. Styles follow [Web styling](../../../../docs/web-styling.md); display text, accessibility labels, and tooltips use typed locale dictionaries.

### Existing decisions

The [generic file upload decision](../../implemented/feature/2026-08-26-generic-file-upload.md) remains authoritative for upload, storage, admission, and ordered message attachments. This proposal revises only its Trajectory presentation and does not fully supersede that record. The [unreadable attachment quarantine proposal](2026-08-20-attachment-read-quarantine.md) concerns model-request recovery and remains independent of thumbnail loading feedback.

## Implementation plan

The steps below define the delivery sequence and completion evidence. They are not a record of commands already run. Use the current [development guide](../../../../docs/development.md), [testing policy](../../../../docs/testing.md), and linked workflows when executing them.

| Step | Work | Completion evidence |
|---|---|---|
| 1. Establish the baseline | Verify the internal repository, live base, clean worktree, dependencies, and applicable rules; use an isolated feature branch. | The repository, branch, and base are identified and unrelated changes are excluded. |
| 2. Associate an Issue | Find the existing task or create its Issue with reproduction, scope, native Type, applicable Project fields, and the acceptance criteria below. | A real Issue owns progress and provides the PR reference. |
| 3. Map consumers | Trace Trajectory attachment data, Summary/Preview composition, Raw serialization, image slots, and any shared props. | Every affected consumer and test owner is identified before interfaces change. |
| 4. Implement presentation | Preserve typed attachment data, fix counts, introduce the shared attachment list, and align Raw disclosures in that order. | All four locations expose the specified information without changing durable message data. |
| 5. Add behavior evidence | Extend projection and component tests, then the recorded mixed-upload browser scenario; cover both inspector entry points and image interactions. | Assertions reject the missing-file, missing-count, ordering, and layout regressions. |
| 6. Update documentation | Update affected README pairs, JSDoc, and the owning decision records with the implementation; record bilingual consistency. | Documentation describes the implemented behavior, and this proposal is rewritten for its final lifecycle when implementation is complete. |
| 7. Validate the outgoing diff | Apply the [pre-push check workflow](../../../skills/dsh-pre-push-checks/SKILL.md) and the client check ladder; inspect the complete diff and changed expected outputs. | Relevant local checks pass, with commands and limitations recorded accurately. |
| 8. Commit and demonstrate | Review hook changes, commit normally, build the clean committed tree, and record one isolated real-server, real-model flow under the [GIF workflow](../../../skills/record-browser-gif/SKILL.md). Push normally and verify the remote head. | The reviewed GIF names the demonstrated commit and serving conditions, and the remote branch contains that commit. |
| 9. Publish and review | Fill the [PR template](../../../../.github/pull_request_template.md), link the Issue, select live kind/area labels, and attach evidence. Check the PR preview and CI; address review on the same branch. | The current head has reviewable evidence; fixes update affected checks and the GIF when its demonstrated commit changes. |
| 10. Merge and follow up | After review, satisfy live approval and merge rules, then follow mainline checks and Issue state. | The authorized merge is verified and any remaining work has an owner; release publication follows its separate workflow. |

### Verification coverage

| Layer | Planned coverage |
|---|---|
| Projection | Text with one image and one file; images only; files only; attachment-only mixed messages; empty text; multiple and repeated attachment occurrences. Counts and raw fields match the input. |
| Components | Summary and Preview show the same attachment names, order, metadata, and activation behavior. Raw preserves block order and complete fields. Cover absent image names, zero-byte files, long filenames, loading, failure, and retry. |
| Assembled application | Extend [file-upload-round](../../../../apps/web/tests/file-upload-round.e2e.ts) and its [recorded scenario](../../../../snapshots/web/file-upload-round/snapshot.yml) to inspect Summary, Preview, and Raw after the mixed upload and after reopening history. Keep the [shared image-cache check](../../../../apps/web/tests/trajectory-image-display.expected.e2e.ts). |
| Browser layout and accessibility | Verify narrow and wide inspector widths, light and dark themes, both locales, complete thumbnail containment, reachable final attachments, and keyboard activation and viewer dismissal. Keep geometry expectations beside their test owner under the [snapshot placement rules](../../../../snapshots/AGENTS.md). |
| Local checks | Run focused tests during implementation, then the required GUI and browser replay checks from the client rules, locale verification, documentation checks, and lint. Normal pre-push runs typecheck; CI owns exhaustive coverage and platform checks. |
| Demonstration | Record mixed submission, the ledger counts, Summary, Preview with image activation, and expanded Raw metadata from one real model session. Keep media outside the feature branch and attach it according to the GIF workflow. |

## Alternatives considered

**Keep large inline images as the default inspector presentation.** This makes one image immediately readable, but a tall image displaces attachment names and message text in the narrow inspector. Compact rows with explicit image activation provide a consistent overview of mixed attachments.

**Use two-column attachment cards.** A grid can make thumbnails more prominent on wide panels, but it leaves less room for long filenames and requires a different narrow-panel arrangement. A single equal-width list is the proposed default.

**Keep file JSON and image previews together in Raw.** This preserves the existing rendering, but assigns different meanings to the same tab for two attachment kinds. Consistent metadata disclosures let readers inspect recorded fields while Preview owns the visual image presentation.

## Acceptance criteria

- A message containing text, one image, and one ordinary file shows both counts in the ledger and both attachments in Summary and Preview.
- Summary and Preview share one attachment renderer; each provides the same ordered attachments and image actions despite their different spacing and containers.
- Attachment-only messages, repeated references, unnamed images, zero-byte files, and long filenames remain identifiable without invented metadata.
- Images fit completely inside compact thumbnails. Keyboard and pointer users can open and dismiss the existing image viewer; a failed image load remains visible and retryable.
- Raw preserves every original content block and its order. Image and file disclosures expose all recorded attachment fields without replacing them with generated labels or downloaded file contents.
- Narrow panels, both themes, and both locales remain usable. Existing Chat/tool-image behavior and per-session image cache reuse retain regression coverage.
- The implementation includes corresponding tests, reviewed keyless browser expectations, paired documentation, and a real-model GIF tied to the demonstrated PR head.

## Risks

Adding file references to view data can accidentally route them through image-only consumers or lose raw fields. Trace every affected discriminant and verify mixed and repeated occurrences. Compact thumbnails reduce immediate readability of diagrams, so full-image activation must remain discoverable. Shared renderer changes can affect Chat and tool results, while Summary's scroll container can hide final rows; both need assembled-browser checks. Missing recorded metadata must remain visibly absent, and image-read failures must not hide unrelated files. Unavailable model credentials block the real-model demonstration and must be reported rather than replaced with fixture footage.
