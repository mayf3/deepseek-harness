/** Plan text and resource identities derived from logged native or PTC calls. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One submitted plan, identified by its originating tool invocation. */
export interface SubmittedPlan {
  readonly callId: ToolCallId
  readonly markdown: string
  readonly title: string
}

/** A saved sidebar resource names one invocation in one Session. */
export interface PlanAddress {
  readonly sessionId: SessionId
  readonly callId: ToolCallId
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a complete plan from untrusted logged arguments.
 * @param event - Native call or PTC dispatch event from Session history.
 * @returns the submitted plan, or undefined for unrelated or malformed data.
 */
export function submittedPlan(event: { readonly type: string; readonly data: unknown }): SubmittedPlan | undefined {
  if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') return undefined
  const data = event.data
  if (!record(data) || data.name !== 'exit_plan_mode') return undefined
  const callId = event.type === 'tool/call' ? data.callId : data.subCallId
  if (typeof callId !== 'string' || callId === '') return undefined
  let args: unknown = data.arguments
  if (event.type === 'tool/call') {
    if (typeof args !== 'string') return undefined
    try { args = JSON.parse(args) as unknown }
    catch (_error) { return undefined /* Malformed model JSON remains in the generic tool row. */ }
  }
  if (!record(args) || typeof args.plan !== 'string') return undefined
  const markdown = args.plan
  const title = /^#\s+(\S[^\r\n]*)/.exec(markdown.trim())?.[1]
  return title === undefined ? undefined : { callId: callId as ToolCallId, markdown, title }
}

/**
 * Encode the durable identity of a plan without retaining its text in layout storage.
 * @param target - Session and tool-call identity.
 * @returns the plan resource address.
 */
export function planAddress(target: PlanAddress): string {
  return `dsh-resource://plan/${encodeURIComponent(target.sessionId)}/${encodeURIComponent(target.callId)}`
}

/**
 * Validate a saved or caller-supplied plan resource address.
 * @param address - Address submitted to the sidebar or resource provider.
 * @returns the decoded identity, or undefined for an unsupported address.
 */
export function parsePlanAddress(address: string): PlanAddress | undefined {
  const match = /^dsh-resource:\/\/plan\/([^/?#]+)\/([^/?#]+)$/.exec(address)
  if (match === null) return undefined
  try {
    return { sessionId: decodeURIComponent(match[1] as string) as SessionId, callId: decodeURIComponent(match[2] as string) as ToolCallId }
  } catch (_error) {
    // Invalid saved percent encoding cannot identify a Session or invocation.
    return undefined
  }
}
