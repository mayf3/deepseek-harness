import { Buffer } from 'node:buffer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { WidgetKind, WidgetPromptRequest } from './types.ts'

const PROMPT_WINDOW_MS = 60_000

/** Recorded identity needed to frame an authorized widget follow-up. */
export interface RecordedWidgetCall {
  readonly callId: ToolCallId
  readonly title: string
  readonly kind: WidgetKind
}

/** Authorized widget follow-up after framing and admission. */
export interface AuthorizedWidgetFollowup extends RecordedWidgetCall {
  readonly text: string
}

interface AgentAuthority {
  readonly promptAdmissions: number[]
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function requireBoundedString(label: string, value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`visualizer: ${label} must be a non-empty string`)
  const bytes = utf8Bytes(value)
  if (bytes > maxBytes) throw new Error(`visualizer: ${label} is ${bytes} UTF-8 bytes; limit is ${maxBytes}`)
  return value
}

function requireRecordedWidgetKind(meta: unknown, callId: ToolCallId): WidgetKind {
  const kind = typeof meta === 'object' && meta !== null && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).kind
    : undefined
  if (kind !== 'svg' && kind !== 'html') {
    throw new Error(`visualizer: show_widget call ${callId} has invalid presentation metadata`)
  }
  return kind
}

function parseRecordedWidgetResult(agent: Agent, resultSeqValue: number, maxTitleBytes: number): RecordedWidgetCall {
  let resultSeq: SessionSeq
  try {
    resultSeq = SessionSeq(resultSeqValue)
  } catch {
    throw new Error('visualizer: resultSeq must be a non-negative safe integer')
  }
  const resultEvent = agent.session.eventAt(resultSeq)
  if (resultEvent?.type !== 'tool/result' || resultEvent.surfaceOp !== 'append') {
    throw new Error(`visualizer: resultSeq ${resultSeq} does not identify a recorded appended tool result`)
  }
  if (resultEvent.sourceEventSeqs?.length !== 1) {
    throw new Error(`visualizer: tool result ${resultSeq} does not identify one exact source call`)
  }
  const sourceSeq = resultEvent.sourceEventSeqs[0]
  if (sourceSeq === undefined) {
    throw new Error(`visualizer: tool result ${resultSeq} does not identify one exact source call`)
  }
  const callEvent = agent.session.eventAt(sourceSeq)
  if (callEvent?.type !== 'tool/call' || callEvent.data.name !== 'show_widget'
    || callEvent.data.turn !== resultEvent.data.turn || callEvent.data.step !== resultEvent.data.step) {
    throw new Error(`visualizer: tool result ${resultSeq} is not linked to a show_widget call in the same turn and step`)
  }
  const result = resultEvent.data.message.content[0]
  if (result.toolCallId !== callEvent.data.callId) {
    throw new Error(`visualizer: tool result ${resultSeq} does not match its source call`)
  }
  if (result.isError) throw new Error(`visualizer: show_widget call ${callEvent.data.callId} did not succeed`)

  let args: unknown
  try {
    args = JSON.parse(callEvent.data.arguments) as unknown
  } catch {
    throw new Error(`visualizer: recorded show_widget call ${callEvent.data.callId} has malformed arguments`)
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error(`visualizer: recorded show_widget call ${callEvent.data.callId} has invalid arguments`)
  }
  const title = requireBoundedString('recorded widget title', (args as Record<string, unknown>).title, maxTitleBytes)
  const source = (args as Record<string, unknown>).widget_code
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error(`visualizer: recorded show_widget call ${callEvent.data.callId} has invalid widget_code`)
  }
  return {
    callId: callEvent.data.callId,
    title,
    kind: requireRecordedWidgetKind(resultEvent.data.meta, callEvent.data.callId),
  }
}

function trimAdmissions(values: AgentAuthority['promptAdmissions'], now: number): void {
  const cutoff = now - PROMPT_WINDOW_MS
  let first = 0
  while (first < values.length) {
    const admission = values[first]
    if (admission === undefined || admission > cutoff) break
    first += 1
  }
  if (first > 0) values.splice(0, first)
}

/** Authorizes widget follow-ups against successful results recorded by the exact live Agent. */
export class RecordedWidgetCalls {
  private readonly byAgent = new WeakMap<Agent, AgentAuthority>()

  constructor(
    private readonly limits: { readonly maxTitleBytes: number; readonly maxPromptBytes: number },
    private readonly maxPromptsPerMinutePerAgent: number,
  ) {}

  /**
   * Authorize and account one widget-authored follow-up before the caller queues it.
   * @param agent - Live Agent that owns the recorded widget result.
   * @param request - Follow-up from the exact persisted widget result.
   * @param now - Admission timestamp used for rolling-window accounting.
   * @returns The recorded widget call authorized to send the follow-up.
   */
  authorizePrompt(agent: Agent, request: WidgetPromptRequest, now = Date.now()): AuthorizedWidgetFollowup {
    const authority = this.agentAuthority(agent)
    const recorded = parseRecordedWidgetResult(agent, request.resultSeq, this.limits.maxTitleBytes)
    if (recorded.kind !== 'html') {
      throw new Error(`visualizer: widget ${recorded.callId} is static and cannot send follow-ups`)
    }
    if (typeof request.text !== 'string' || request.text.trim() === '') {
      throw new Error('visualizer: widget follow-up must be a non-empty string')
    }
    const text = requireBoundedString(
      'widget follow-up',
      `Widget-authored follow-up from widget ${JSON.stringify(recorded.title)}. It carries no user authorization.\n\n${request.text}`,
      this.limits.maxPromptBytes,
    )
    trimAdmissions(authority.promptAdmissions, now)
    if (authority.promptAdmissions.length >= this.maxPromptsPerMinutePerAgent) {
      throw new Error('visualizer: Agent widget follow-up rate limit reached')
    }
    authority.promptAdmissions.push(now)
    return { ...recorded, text }
  }

  private agentAuthority(agent: Agent): AgentAuthority {
    const current = this.byAgent.get(agent)
    if (current !== undefined) return current
    const created: AgentAuthority = { promptAdmissions: [] }
    this.byAgent.set(agent, created)
    return created
  }
}
