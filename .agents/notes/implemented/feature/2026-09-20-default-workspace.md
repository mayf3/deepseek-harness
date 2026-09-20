# Agent Note: First-use default Workspace

Status: implemented

English | [中文](2026-09-20-default-workspace.zh.md)

## Problem

A new installation requires a directory choice before the user can send a first message. Removing that prerequisite must preserve the Session's fixed working directory and must not treat hidden or archived history as a new installation.

## Decision

The conversation shell retains an unsent local text draft without creating a Session. Its first send asks the Host to prepare a default Workspace, then connects a real Session and submits through the ordinary composer pipeline. The first-use draft awaits staged mode selection before automatic submission. This partially supersedes the locked no-Session composer in [Session scope and provisioning](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md); that note still owns blank-Session reuse and provisioning rationale.

The [Workspace registry](../../../../packages/workspace/workspace/README.md#first-use-workspace) owns eligibility and directory preparation. All live Sessions, persisted headers, and archived identities count, including entries absent from the sidebar. The operation shares the registry mutation queue and rechecks Session history after directory preparation because Sessions can start independently.

The Client resolves the initial directory name and title from its language when sending. The Host controller resolves the Documents location; the registry receives a directory resolver with no locale dependency. The resolver runs inside the mutation queue only for eligible creation, so repeated requests reuse the durable Workspace without another OS lookup. A durable Workspace id records successful initialization independently of that name. Renaming, changing language, restarting, or deleting the registration cannot initialize another default. The marker commits with the registration, so a failed registration can retry. Directory contents remain subject to the existing [metadata-only deletion policy](2026-07-27-workspace-registration-deletion.md).

Creation failure preserves the draft and offers the existing folder picker. A successful registration survives Session creation or prompt failure. Picking a folder after failure transfers the text without sending it; a later send remains the user's action.

## Alternatives considered

- Creating on application startup would write directories for users who never send a message.
- Inferring first use from visible sidebar rows would ignore archived, hidden, and cwd-less Sessions.
- Using the localized path as the initialization marker would allow language changes or deletion to create another default.
- Changing a Session's cwd after creation would change the meaning of its recorded tools and attachments.

## Consequences

First-use typing has no Host Session or filesystem effects. Preparation remains a Host responsibility for both Desktop and remote Web clients, so remote users use the Host account's Documents location. Unavailable Documents lookup fails with the same folder-selection recovery as directory creation failure.

The feature preserves [reference-owned Client Session lifetimes](../architecture/2026-09-15-client-session-references.md) and requires no agent-loop or Session-event change. Registry and client tests cover retries, hidden history, concurrency, and draft recovery; the [browser scenario](../../../../apps/web/tests/default-workspace.e2e.ts) verifies the assembled first-send and picker paths with an isolated Documents directory and recorded Session replay.
