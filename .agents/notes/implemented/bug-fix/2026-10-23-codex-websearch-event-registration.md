# Agent Note: Register the Codex web-search event in the durable vocabulary

Status: implemented

English | [中文](2026-10-23-codex-websearch-event-registration.zh.md)

## Problem

The out-of-repo `dsh-openai-codex` provider plugin appends an unmarked `web/openai-codex-search-llm-request` event to the initiating session's durable log before each search dispatch. The persistence read path refuses any log containing an event type outside `KNOWN_SESSION_EVENT_TYPES` unless that event carries the envelope's `ignorable: true` (`assertEventsSupported`), so the first resume of such a session by a worker that never mounted the plugin rejected the entire log and took the session's full history offline. The failure surfaced fleet-wide on worker restart, idle reclaim, and fence cleanup, and it recurred after temporary deployed-tree and data repairs because neither survives a release: direct deployed-tree edits are overwritten, and runtime registration covers only processes that load the writing plugin.

## Decision

The event is now a permanent member of the build's durable vocabulary. Core session declares the exact event type and its exact secret-free payload record (`OpenAICodexSearchLlmRequest`, mirrored from the plugin's writer), and the generated catalog adds the type to `KNOWN_SESSION_EVENT_TYPES` through the normal `gen-persistence-catalog` run. Every build of this repository therefore reads logs carrying the event regardless of which plugins are mounted, and already-written unmarked logs become readable without any data rewrite.

The registration is exact, not a namespace rule: `web/openai-codex-search-llm-request` is the only added member, every other unknown type — including unknown `web/*` names — keeps refusing the log, and the required-on-read default and the `ignorable` envelope contract are unchanged. Reader behavior is otherwise untouched: events keep their order and sequence, and business messages neither replay nor deduplicate.

## Alternatives considered

**Plugin-side runtime registration** — the plugin's `installOpenAICodexSearchEvent` already adds the type to the running process's set. Rejected as the fix: registration lives only for the process lifetime and only in processes that mount the plugin, which is precisely the composition that failed in production; the deployed plugin version already registered at runtime and the poisoning recurred.

**Mark the event ignorable at the writer** — rejected here: the writer lives in another repository, the marker would not make already-written unmarked logs readable, and it would move the load-safety promise from the vocabulary to the discipline of every future telemetry writer.

**Ignore the whole `web/*` namespace** — rejected: it would silently admit unknown future web-semantics events and break the fail-closed default that protects log interpretation.

**A generic runtime registration surface in core** — rejected for this fix: it shares the process-lifetime limitation, and a build-time vocabulary entry is the only surface that covers plugin-less readers such as fresh workers, tooling, and UI processes.

## Consequences

Sessions that use Codex web search resume across worker restarts in every build from this source. The catalog documents the payload as the authoritative contract. One cross-repository follow-up is coordinated, not blocking: the plugin declares the same key through its own `declare module` merge with a locally named payload type, so once it type-checks against a harness build carrying this registration, that duplicate merge must reference the harness type or be dropped. The operator-side transition mitigations (data sweep, deployed-tree patch, launchd guard) remain the deployment line's to retire after this registration ships.
