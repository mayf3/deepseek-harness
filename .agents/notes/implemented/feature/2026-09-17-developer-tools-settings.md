# Agent Note: Shared developer-tool settings

Status: implemented

English | [中文](2026-09-17-developer-tools-settings.zh.md)

## Problem

Diagnostic views, preset selection and changed-file summaries add complexity to routine tasks. Scripted HTML also grants capabilities that a basic document preview does not need. Desktop and Web share these renderers, so independent switches would let the same setting produce different results across clients.

## Decision

The settings owner exposes one accepted `ui-developer-tools.enabled` preference, defaulting off. General Settings offers the same switch on Web and desktop. The existing settings transport owns validation, ordered writes, persistence and recovery; the browser adds no second copy of the preference. Loopback Web and desktop use Host persistence, while remote Web retains the existing memory policy.

Off exposes only Chat, removes the conversation View tab bar, hides the new-session preset chip, and omits the changed-files card and its summary read. Turning it off from another View activates Chat. The preset composition, saved default, Session events and explicit delivery cards remain unchanged. This preference is presentation policy, not Host authorization.

The builtin HTML renderer enforces its own preview policy. Off parses into an inert template, removes active documents and navigation, and mounts an iframe with no sandbox permissions and a CSP denying scripts and external resources. It reads no related files. On retains the opaque scripted Blob renderer and its bounded related-file reads. Switching modes replaces the browsing context and disposes pending reads. The [document-preview decision](../architecture/2026-09-08-document-preview-operations.md) and [filesystem-read authority](../architecture/2026-09-09-workspace-file-read-authority.md) remain authoritative for advanced rendering and Host read access.

## Alternatives considered

**Limit the switch to desktop.** The selected requirement contains no desktop-only restriction, and the affected UI is shared. A desktop check would leave the Web renderer with inconsistent visibility and preview behavior.

**Hide controls without changing the active View or iframe.** Previously selected diagnostic content and already-running scripts would survive the toggle. Filtering the available View roster and remounting the HTML context enforce the selected presentation immediately.

## Consequences

Basic HTML sacrifices JavaScript, external and related resources, and link navigation; inline styles and data images remain available. Advanced mode retains normal browser networking and does not gain parent-origin, popup, form or top-navigation privileges. The setting does not constrain third-party preview implementations or revoke Host filesystem authority.

Component and settings tests cover defaulting, schema rejection, accepted-state updates, chip disclosure, changed-file visibility and iframe disposal. The recorded-session [document preview](../../../../apps/web/tests/document-preview.e2e.ts) and [changed-files](../../../../apps/web/tests/changed-files-turn.e2e.ts) scenarios exercise the real settings control and the shared renderer. The browser scaffold explicitly seeds developer mode for diagnostic scenarios; these two scenarios leave the shipped default untouched. Native Electron execution is a separate acceptance surface.
