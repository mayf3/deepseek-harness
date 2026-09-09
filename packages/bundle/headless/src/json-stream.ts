/**
 * `--json` run projection: a bounded, ordered event stream derived from one
 * Agent's durable Session events plus its live Assistant frames. The stream is
 * a small vocabulary rather than a dump of the Session log, so a supervising
 * process can consume it without filtering internal events or de-duplicating
 * an assembled message against its own deltas.
 * @module @deepseek-ai/dsh-headless/json-stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Default delay before a buffered streaming delta is flushed. */
export const COALESCE_MS = 100

/** Default buffered byte count that flushes streaming deltas immediately. */
export const COALESCE_BYTES = 512

/** Default per-string cap applied to every projected payload. */
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
  /** Coalescing delay for streaming deltas in milliseconds. */
  coalesceMs?: number
  /** Buffered delta bytes that flush immediately instead of waiting. */
  coalesceBytes?: number
  /** Per-string byte cap; longer strings are truncated and flagged. */
  maxStringBytes?: number
}

/** The live handle of one `--json` projection. */
export interface JsonProjection {
  /** Flush buffered deltas and write the terminal `final` event. */
  finish(text: string): void
  /** Stop observing; buffered deltas that were never flushed are discarded. */
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

/** Recursively cap every string in one JSON-serializable value. */
function boundValue(value: unknown, maxBytes: number, state: BoundState): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
    state.truncated = true
    return truncateUtf8(value, maxBytes)
  }
  if (Array.isArray(value)) return value.map(item => boundValue(item, maxBytes, state))
  if (value !== null && typeof value === 'object') {
    const bounded: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) bounded[key] = boundValue(item, maxBytes, state)
    return bounded
  }
  return value
}

/** Bound one event payload and flag the event when any string was cut. */
function boundEvent(event: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const state: BoundState = { truncated: false }
  const bounded = boundValue(event, maxBytes, state) as Record<string, unknown>
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
 * caller must invoke this before submitting the task. Deltas are coalesced but
 * always flushed before any later event, which preserves stream order.
 * @param ctx - plugin context carrying the live Session and Assistant feeds.
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
  const coalesceMs = options.coalesceMs ?? COALESCE_MS
  const coalesceBytes = options.coalesceBytes ?? COALESCE_BYTES
  const maxStringBytes = options.maxStringBytes ?? MAX_STRING_BYTES
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let bufferedBytes = 0
  const deltas: { kind: 'text' | 'thinking'; text: string }[] = []
  let stepUsage: SessionEvent<'assistant/message'>['data']['usage']

  const write = (event: Record<string, unknown>): void => {
    if (disposed) return
    sink.write(`${JSON.stringify(boundEvent(event, maxStringBytes))}\n`)
  }

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    bufferedBytes = 0
    for (const delta of deltas.splice(0)) write({ type: delta.kind, text: delta.text })
  }

  const emit = (event: Record<string, unknown>): void => {
    flush()
    write(event)
  }

  const pushDelta = (kind: 'text' | 'thinking', text: string): void => {
    const last = deltas[deltas.length - 1]
    if (last !== undefined && last.kind === kind) last.text += text
    else deltas.push({ kind, text })
    bufferedBytes += Buffer.byteLength(text, 'utf8')
    if (bufferedBytes >= coalesceBytes) {
      flush()
      return
    }
    timer ??= setTimeout(flush, coalesceMs)
  }

  const onSessionEvent = (session: unknown, event: SessionEvent): void => {
    if (session !== agent.session) return
    switch (event.type) {
      case 'turn/start':
        emit({ type: 'status', phase: 'turn_start', turn: event.data.turn })
        return
      case 'step/start':
        emit({ type: 'status', phase: 'step_start', turn: event.data.turn, step: event.data.step })
        return
      case 'assistant/message':
        stepUsage = event.data.usage
        return
      case 'step/end': {
        const usage = stepUsage
        stepUsage = undefined
        emit({
          type: 'status', phase: 'step_end', turn: event.data.turn, step: event.data.step,
          ...usage === undefined ? {} : { usage },
        })
        return
      }
      case 'turn/end':
        emit({ type: 'status', phase: 'turn_end', turn: event.data.turn, reason: event.data.reason })
        return
      case 'tool/call':
        emit({
          type: 'tool_call',
          callId: event.data.callId,
          tool: event.data.name,
          input: parseArguments(event.data.arguments),
        })
        return
      case 'tool/result': {
        const block = event.data.message.content[0]
        emit({
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

  const onFrame = (payload: { agent: Agent; frame: AssistantStreamFrame }): void => {
    if (payload.agent !== agent) return
    const frame = payload.frame
    if (frame.type !== 'chunk') {
      flush()
      return
    }
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'text-delta':
        if (chunk.text !== '') pushDelta('text', chunk.text)
        return
      case 'reasoning-delta':
        if (chunk.text !== '') pushDelta('thinking', chunk.text)
        return
      case 'block-start':
      case 'block-end':
      case 'tool-call-delta':
      case 'usage':
      case 'finish':
        flush()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return
    }
  }

  write({ type: 'session', sessionId: agent.id, cwd: options.cwd ?? process.cwd() })
  const stopSession = ctx.on('session/event', onSessionEvent)
  const stopStream = ctx.on('agent/assistant-stream', onFrame)

  return {
    finish(text: string): void {
      flush()
      write({ type: 'final', text })
    },
    dispose(): void {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      deltas.length = 0
      stopSession()
      stopStream()
    },
  }
}
