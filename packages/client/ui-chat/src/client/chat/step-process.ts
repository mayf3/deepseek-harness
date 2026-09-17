/** Consecutive process material, separated by visible assistant responses and turn boundaries. */
import type { ChatNode } from '../contract/chat-nodes.ts'
import { isRunningTool } from '../contract/chat-nodes.ts'
import type { ChatSnapshot, ToolCallBlock } from '../contract/snapshot.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'

/** One stable renderer seat, optionally restricted to part of an assistant node. */
export interface ProcessSeat {
  readonly nodeKey: string
  readonly assistantPart?: 'reasoning' | 'response'
}

/** A consecutive process range or a standalone transcript row. */
export interface ProcessRange {
  readonly key: string
  readonly seats: readonly [ProcessSeat, ...ProcessSeat[]]
  readonly process: boolean
  readonly closed: boolean
  readonly turn: number | undefined
}

const INDEPENDENT = new Set(['user', 'steering', 'turn-trigger', 'model-retry', 'turn-error', 'turn-max-tokens', 'turn-tail', 'turn-process'])

/**
 * Divide loaded rows without altering durable nodes or response order.
 * @param snapshot - current chat publication, including live keyed nodes.
 * @returns ranges with stable first-seat keys and response-closed status.
 */
export function processRanges(snapshot: ChatSnapshot): ProcessRange[] {
  const ranges: ProcessRange[] = []
  const responseTurns = new Set<number | undefined>()
  let pending: ProcessSeat[] = []
  let pendingTurn: number | undefined
  const flush = (closed: boolean): void => {
    const [first, ...rest] = pending
    if (first !== undefined) ranges.push({
      key: `${first.nodeKey}:process`, seats: [first, ...rest], process: true, closed, turn: pendingTurn,
    })
    pending = []
  }
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key) as ChatNode | undefined
    if (node === undefined || node.visibility === 'hidden') continue
    const location = node.location
    const turn = location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
    if (pending.length > 0 && turn !== pendingTurn) flush(true)
    pendingTurn = turn
    if (INDEPENDENT.has(node.kind) || turn === undefined
      || (node.kind === 'system-prompt' && !responseTurns.has(turn))) {
      // The synthetic whole-turn control must not split an ongoing process range.
      if (node.kind === 'turn-process') {
        ranges.push({ key, seats: [{ nodeKey: key }], process: false, closed: true, turn })
        continue
      }
      flush(true)
      ranges.push({ key, seats: [{ nodeKey: key }], process: false, closed: true, turn })
    } else if (node.kind === 'assistant-step') {
      if (node.data.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '')) {
        pending.push({ nodeKey: key, assistantPart: 'reasoning' })
      }
      if (hasAssistantReplyContent(node.data.blocks)) {
        responseTurns.add(turn)
        flush(true)
        ranges.push({ key, seats: [{ nodeKey: key, assistantPart: 'response' }], process: false, closed: true, turn })
      }
    } else {
      pending.push({ nodeKey: key })
    }
  }
  const lastTurn = pendingTurn === undefined ? undefined : snapshot.timeline.turns.get(pendingTurn)
  flush(lastTurn?.status !== 'open')
  return ranges
}

/** Tool categories used by abstract process titles. */
export type ProcessActivity = 'read' | 'search' | 'edit' | 'commands' | 'code'
  | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools'

function activity(name: string): ProcessActivity {
  if (['read', 'read_image', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name)) return 'read'
  if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) return 'search'
  if (['write', 'edit', 'apply_patch'].includes(name)) return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(name) || name.startsWith('terminal_')) return 'commands'
  if (name === 'run_code') return 'code'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (name === 'subagent' || name.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(name)) return 'plan'
  if (name === 'ask_user_question' || name === 'request_user_input') return 'questions'
  return 'tools'
}

function liveToolDetail(argsRaw: string): string {
  let args: unknown
  try {
    args = JSON.parse(argsRaw)
  } catch {
    // Partial argument JSON has no complete detail to preview.
    return ''
  }
  if (args === null || typeof args !== 'object') return ''
  for (const key of ['command', 'cmd', 'queries', 'query', 'pattern', 'url', 'file_path', 'path', 'description']) {
    if (key in args) {
      const value: unknown = Reflect.get(args, key)
      if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
        const detail = value.join(', ').replace(/\s+/g, ' ').trim()
        if (detail !== '') return detail
      }
      if (typeof value === 'string' && value.trim() !== '') return value.replace(/\s+/g, ' ').trim()
    }
  }
  return ''
}

/**
 * Rank categories by distinct call count, breaking ties by first appearance.
 * @param nodes - process members, including recursive tools.
 * @returns all ranked categories and the latest running tool category and argument preview.
 */
export function processActivity(nodes: readonly ChatNode[]): {
  counts: readonly { kind: ProcessActivity; count: number }[]
  running: ProcessActivity | undefined
  runningDetail: string
} {
  const counts = new Map<ProcessActivity, number>()
  const seen = new Set<string>()
  let running: ProcessActivity | undefined
  let runningDetail = ''
  let runningTime = -Infinity
  const visit = (tool: ToolCallBlock): void => {
    if (seen.has(tool.callId)) return
    seen.add(tool.callId)
    const call = isRunningTool(tool) ? tool : tool.call
    if (call !== null) {
      const kind = activity(call.name)
      if (isRunningTool(tool) && tool.time >= runningTime) {
        running = kind
        runningDetail = liveToolDetail(tool.argsRaw)
        runningTime = tool.time
      }
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    for (const child of tool.subCalls) visit(child)
  }
  for (const node of nodes) {
    if (node.kind === 'tool-call') visit(node.data.root)
  }
  return {
    counts: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    running,
    runningDetail,
  }
}

/**
 * Compose localized abstract status or the top three completed categories without counts.
 * @param summary - ranked work and phase evidence for this range.
 * @param closed - whether a following reply or turn boundary closed the range.
 * @param t - Chat namespace translator.
 * @returns the secondary disclosure title.
 */
export function processTitle(
  summary: ReturnType<typeof processActivity>,
  closed: boolean,
  t: import('../contract/slots.ts').ChatViewSlotProps['t'],
): string {
  if (!closed) return t(`message.stepProcess.${summary.running ?? 'thinking'}`)
  const labels = summary.counts.slice(0, 3).map(({ kind }) => t(`message.stepProcess.done.${kind}`))
  const first = labels[0]
  if (first === undefined) return t('message.stepProcess.done.thinking')
  const continuation = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1)
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) {
    const prefix = t('message.stepProcess.sharedPrefix')
    const shared = prefix !== '' && first.startsWith(prefix) && second.startsWith(prefix)
    return t('message.stepProcess.joinTwo', { first, second: continuation(shared ? second.slice(prefix.length) : second) })
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(t('message.stepProcess.comma'))
  return summary.counts.length > 3 ? t('message.stepProcess.more', { title }) : title
}
