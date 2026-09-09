/**
 * `--json` run projection: a bounded, ordered event stream derived from one
 * Agent's durable Session events. Every projected event is a commit point:
 * text and reasoning come from committed `assistant/message` content, never
 * from a live attempt that may still be retried or discarded, so the stream
 * never carries content the durable log does not contain.
 * @module @deepseek-ai/dsh-headless/json-stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Default per-string and per-key cap applied to every bounded projected payload. */
export const MAX_STRING_BYTES = 8 * 1024

/** The stdout sink a projection writes newline-delimited events to. */
export interface JsonSink {
  /** Write one chunk of the event stream. */
  write(chunk: string): unknown
}

/** Tunables for {@link projectJsonRun}; every field defaults. */
export interface JsonProjectionOptions {
  /** Working directory reported by the opening `session` event. */
  cwd?: string
  /** Per-string and per-key byte cap; longer values are truncated and flagged. */
  maxStringBytes?: number
}

/** The live handle of one `--json` projection. */
export interface JsonProjection {
  /** Write the terminal `final` event carrying the run's answer text. */
  finish(text: string): void
  /** Stop observing the Session. */
  dispose(): void
}

/** Mutable truncation state threaded through one payload bound. */
interface BoundState {
  truncated: boolean
}

/** Truncate one UTF-8 string to `maxBytes`, dropping a split trailing character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  const decoded = buffer.toString('utf8')
  return decoded.endsWith('\uFFFD') ? decoded.slice(0, -1) : decoded
}

/** Cap one object key, flagging the payload when it was cut. */
function boundKey(key: string, maxBytes: number, state: BoundState): string {
  if (Buffer.byteLength(key, 'utf8') <= maxBytes) return key
  state.truncated = true
  return truncateUtf8(key, maxBytes)
}

/** Recursively cap every string in one JSON-serializable value, keys included. */
function boundValue(value: unknown, maxBytes: number, state: BoundState): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
    state.truncated = true
    return truncateUtf8(value, maxBytes)
  }
  if (Array.isArray(value)) return value.map(item => boundValue(item, maxBytes, state))
  if (value !== null && typeof value === 'object') {
    // A null prototype keeps a literal `__proto__` key as data instead of
    // invoking the inherited setter, which would silently drop it. Two keys
    // that share a truncated prefix collide last-wins; only a payload naming
    // two multi-kilobyte keys can reach that.
    const bounded = Object.create(null) as Record<string, unknown>
    for (const [key, item] of Object.entries(value)) {
      bounded[boundKey(key, maxBytes, state)] = boundValue(item, maxBytes, state)
    }
    return bounded
  }
  return value
}

/**
 * Bound every string and key in one projected payload, adding `truncated: true`
 * when any was cut. Exported so the runner applies the same limit to its
 * process-level `error` event.
 * @param event - the event payload to bound.
 * @param maxStringBytes - per-string and per-key byte cap.
 * @returns a copy with every over-long string and key truncated.
 */
export function boundJsonEvent(
  event: Record<string, unknown>,
  maxStringBytes: number = MAX_STRING_BYTES,
): Record<string, unknown> {
  const state: BoundState = { truncated: false }
  const bounded = boundValue(event, maxStringBytes, state) as Record<string, unknown>
  if (state.truncated) bounded.truncated = true
  return bounded
}

/** Parse raw tool-call arguments, keeping the unparsed string when it is not JSON. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/** Join the text blocks of a tool result's model-facing content. */
function resultText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block): block is { type: string; text: string } =>
      block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * Project one Agent's run as newline-delimited JSON on `sink`.
 *
 * The opening `session` event is written before the subscription starts, so a
 * caller must invoke this before submitting the task. Text and reasoning are
 * emitted only when the step's `assistant/message` commits them, and the
 * terminal `final` event carries the same lossless answer the default mode
 * prints (it is deliberately not bounded).
 * @param ctx - plugin context carrying the live Session feed.
 * @param agent - the exact Agent whose events belong to this invocation.
 * @param sink - stdout sink receiving one JSON object per line.
 * @param options - projection tunables.
 * @returns the projection handle that finishes or disposes the stream.
 */
export function projectJsonRun(
  ctx: Context,
  agent: Agent,
  sink: JsonSink,
  options: JsonProjectionOptions = {},
): JsonProjection {
  const maxStringBytes = options.maxStringBytes ?? MAX_STRING_BYTES
  let disposed = false
  let stepUsage: SessionEvent<'assistant/message'>['data']['usage']

  const write = (event: Record<string, unknown>): void => {
    sink.write(`${JSON.stringify(boundJsonEvent(event, maxStringBytes))}\n`)
  }

  const onSessionEvent = (session: unknown, event: SessionEvent): void => {
    if (session !== agent.session) return
    switch (event.type) {
      case 'turn/start':
        write({ type: 'status', phase: 'turn_start', turn: event.data.turn })
        return
      case 'step/start':
        write({ type: 'status', phase: 'step_start', turn: event.data.turn, step: event.data.step })
        return
      case 'assistant/message':
        stepUsage = event.data.usage
        for (const block of event.data.message.content) {
          if (block.type === 'reasoning') write({ type: 'thinking', text: block.text })
          else if (block.type === 'text') write({ type: 'text', text: block.text })
        }
        return
      case 'step/end': {
        const usage = stepUsage
        stepUsage = undefined
        write({
          type: 'status', phase: 'step_end', turn: event.data.turn, step: event.data.step,
          ...usage === undefined ? {} : { usage },
        })
        return
      }
      case 'turn/end':
        write({ type: 'status', phase: 'turn_end', turn: event.data.turn, reason: event.data.reason })
        return
      case 'tool/call':
        write({
          type: 'tool_call',
          callId: event.data.callId,
          tool: event.data.name,
          input: parseArguments(event.data.arguments),
        })
        return
      case 'tool/result': {
        // Compaction replaces older results in the surface; those are history,
        // not this run's output, and would otherwise duplicate a callId.
        if (event.surfaceOp !== 'append') return
        const block = event.data.message.content[0]
        write({
          type: 'tool_result',
          callId: block.toolCallId,
          status: block.isError === true ? 'error' : 'completed',
          result: resultText(block.content),
        })
        return
      }
      default:
        return
    }
  }

  write({ type: 'session', sessionId: agent.id, cwd: options.cwd ?? process.cwd() })
  const stopSession = ctx.on('session/event', onSessionEvent)

  return {
    finish(text: string): void {
      // The answer is the lossless terminal contract, so it is not truncated.
      if (disposed) return
      sink.write(`${JSON.stringify({ type: 'final', text })}\n`)
    },
    dispose(): void {
      disposed = true
      stopSession()
    },
  }
}
