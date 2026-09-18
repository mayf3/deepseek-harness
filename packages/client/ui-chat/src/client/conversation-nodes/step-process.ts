/** Consecutive process material, separated by visible assistant responses and turn boundaries. */
import { isVisibleChatNode } from '../contract/chat-visibility.ts'
import type { ProcessSeat, ProcessRange, ProcessActivity, ProcessActivitySummary } from '../contract/step-process.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { isRunningTool } from '../contract/chat-nodes.ts'
import type { ChatSnapshot, ToolCallBlock } from '../contract/snapshot.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'

const INDEPENDENT = new Set(['user', 'steering', 'turn-trigger', 'model-retry', 'turn-error', 'turn-max-tokens', 'turn-tail', 'turn-process'])

/**
 * Divide loaded rows without altering durable nodes or response order.
 * @param snapshot - current chat publication, including live keyed nodes.
 * @returns ranges with stable first-seat keys and response-closed status.
 */
export function processRanges(snapshot: Pick<ChatSnapshot, 'order' | 'nodes' | 'timeline'>): ProcessRange[] {
  const ranges: ProcessRange[] = []
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
    if (node === undefined || !isVisibleChatNode(node)) continue
    const location = node.location
    const turn = location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
    if (pending.length > 0 && turn !== pendingTurn) flush(true)
    pendingTurn = turn
    if (INDEPENDENT.has(node.kind) || turn === undefined) {
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
        flush(true)
        ranges.push({ key, seats: [{ nodeKey: key, assistantPart: 'response' }], process: false, closed: true, turn })
      }
    } else {
      pending.push({ nodeKey: key })
    }
  }
  const lastTurn = pendingTurn === undefined ? undefined : snapshot.timeline.turns.get(pendingTurn)
  flush(lastTurn?.status === 'closed')
  return ranges
}


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

const LIVE_TOOL_DETAIL_MAX_CHARS = 160
const LIVE_TOOL_DETAIL_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const LIVE_TOOL_DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question', 'questions', 'prompt', 'message',
  'command', 'cmd', 'queries', 'query', 'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status',
] as const

function normalizeLiveToolDetail(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every(item => typeof item === 'string')
      ? value.join(', ')
      : ''
  const normalized = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(LIVE_TOOL_DETAIL_SEGMENTER.segment(normalized), part => part.segment)
  return chars.length <= LIVE_TOOL_DETAIL_MAX_CHARS
    ? normalized
    : `${chars.slice(0, LIVE_TOOL_DETAIL_MAX_CHARS - 1).join('').trimEnd()}…`
}

function questionDetail(value: unknown): string {
  if (!Array.isArray(value)) return ''
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const detail = normalizeLiveToolDetail(Reflect.get(item, 'question'))
    if (detail !== '') return detail
  }
  return ''
}

function liveReasoningDetail(nodes: readonly ChatNode[]): string {
  for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
    const node = nodes[nodeIndex]
    if (node?.kind !== 'assistant-step' || node.data.status !== 'running') continue
    for (let blockIndex = node.data.blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = node.data.blocks[blockIndex]
      if (block?.kind !== 'reasoning') continue
      const paragraphs = block.text.split(/\r?\n[\t ]*\r?\n/)
      for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex--) {
        const detail = normalizeLiveToolDetail(paragraphs[paragraphIndex]?.replaceAll('**', ''))
        if (detail !== '') return detail
      }
    }
  }
  return ''
}

function liveToolDetail(name: string, argsRaw: string): string {
  let args: unknown
  try {
    args = JSON.parse(argsRaw)
  } catch {
    // Partial or free-form arguments have no safe one-line task detail.
    return normalizeLiveToolDetail(name)
  }
  if (args === null || typeof args !== 'object') return normalizeLiveToolDetail(name)
  for (const key of LIVE_TOOL_DETAIL_KEYS) {
    if (key in args) {
      const value: unknown = Reflect.get(args, key)
      const detail = key === 'questions' ? questionDetail(value) : normalizeLiveToolDetail(value)
      if (detail !== '') return detail
    }
  }
  return normalizeLiveToolDetail(name)
}

/**
 * Rank categories by distinct call count, breaking ties by first appearance.
 * @param nodes - process members, including recursive tools.
 * @returns all ranked categories and the latest running tool category and bounded task detail.
 */
export function processActivity(nodes: readonly ChatNode[]): ProcessActivitySummary {
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
        runningDetail = liveToolDetail(tool.name, tool.argsRaw)
        runningTime = tool.time
      }
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    for (const child of tool.subCalls) visit(child)
  }
  for (const node of nodes) {
    if (node.kind === 'tool-call') visit(node.data.root)
  }
  if (running === undefined) runningDetail = liveReasoningDetail(nodes)
  return {
    counts: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    running,
    runningDetail,
  }
}
