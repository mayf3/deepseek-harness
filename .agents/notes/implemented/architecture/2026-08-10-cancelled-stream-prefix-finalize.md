# Agent Note: Cancelled streams finalize their delivered prefix

Status: implemented

English | [中文](2026-08-10-cancelled-stream-prefix-finalize.zh.md)

## Problem

A turn cancelled mid-stream used to drop everything the interrupted step had streamed: `assistant/chunk` events stayed in the log for replay, but no `assistant/message` joined the surface, so `deriveMessages()` carried nothing of the interrupted output into the next request. The user had watched the text stream and clients keep rendering it after the abort, yet from the model's perspective that text was never said. A follow-up like "expand on your second point" could not connect, and a fork taken at the cancelled turn inherited a surface missing content its owner had read. This divergence was never a weighed decision — the first agent-loop implementation checked the abort signal inside the chunk loop and threw before the finalize append, and the later surface whitelist froze that shape in.

The governing principle this violated: what the user can see, the next model request contains.

## Decision

`Agent.step()` keeps the current streaming attempt (assembler, logged chunk seqs, provider route) alive across the request loop. When an abort escapes the step while an attempt is uncommitted, `appendInterruptedAssistant` finalizes the attempt's user-visible prefix as the step's `assistant/message` with `interrupted: true` — `surfaceOp: 'append'`, `sourceEventSeqs` citing exactly the logged chunks — before the abort continues to the `step/end`/`turn/end` teardown. The durable marker is the classification consumers read: the chat projection keeps rendering the settled prefix as interrupted (the Stopped chip), and request inspection leaves the request uncompleted so the step boundary classifies it as before. An attempt that ends in an `error`/`aborted` finish is cleared before the recovery waterfall runs: provider failures commit nothing, and a cancel landing during recovery (typically the `llm/retry` backoff, after clients reset the streamed rendering) must not resurrect the failed stream's prefix.

`BlockAssembler.interruptedBlocks()` owns what is safe to finalize, next to the existing max-tokens truncation rule: closed and open `text`/`reasoning` blocks with non-whitespace content, in stream order. Tool calls are dropped whole — interruption precedes dispatch, so a kept call would demand a fabricated result — as are empty blocks and open blocks of unknown type. When nothing survives, no event is appended and the turn keeps its previous shape: chunks, `step/end`, `turn/end` aborted.

Cancellation during tool execution is untouched: the tool-call message was already finalized, started calls drain into real results, and undispatched calls keep their synthetic `ABORTED_BEFORE_DISPATCH` pairs. Provider failures (terminal error or aborted finishes) still commit nothing; only turn cancellation finalizes a prefix, because only there did the user watch content that would otherwise vanish from the model's history.

## Alternatives considered

**Keep dropping the prefix (status quo).** Safe and simple, but it makes cancel-then-redirect — a high-frequency flow — manufacture a user-visible/model-visible split on every use, and fork inherits the gap. Rejected: the split's cost recurs; the finalize cost is one-time.

**Project the prefix at request time from the logged chunks.** No new surface event; `deriveMessages()` would assemble chunk prefixes for aborted steps. Rejected: it moves assembly policy into every surface consumer, breaks the "three message-producing event types" surface contract, and makes the derived history depend on non-surface events.

**Finalize complete tool-call blocks too, with synthetic aborted results.** Preserves more of the model's intent. Rejected: the calls never dispatched and never rendered as tool cards, so parity does not ask for them, and fabricated result pairs add model-visible noise; the max-tokens rule already drops undispatchable calls.

**Append an explicit interruption marker (`[interrupted by user]` user message).** What Claude Code does; tells the model its answer was cut off rather than complete. Deferred, not rejected: it is a separate model-visible vocabulary decision (source kind, UI rendering, locale strings) stacked on top of this parity fix, and the durable `turn/end aborted` already records the fact for a future projection to use.

## Consequences

The surface now contains what the user saw at the moment of cancellation, so post-cancel follow-ups and forks connect. The cancel and goal snapshot fixtures record the finalized prefix event, and the ACP bridge forwards it as a final `agent_message_chunk` update after the cancelled stop reason — prompt settlement does not wait on loop teardown, so automation clients may receive the update after the cancelled stop reason. An interrupted step's `assistant/message` carries a mid-sentence prefix and the `interrupted: true` marker that classifies it. Terminal provider errors keep the old behavior — their streamed prefix still vanishes from the surface — an asymmetry deliberately left for a follow-up decision because error turns end without the user choosing to stop.

## Testing

`packages/core/agent-loop/tests/cancel.spec.ts` pins mid-stream finalize (content, cited seqs, event order, next-request parity), reasoning-only finalize, half-streamed tool-call dropping, and the nothing-to-finalize case. `packages/llm/llm/tests/assembler.spec.ts` pins `interruptedBlocks()`. The keyless `cancel` ACP snapshot and the goal-session snapshot carry the assembled-application transcript.
