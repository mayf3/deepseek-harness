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

const INDEPENDENT = new Set(['user', 'steering', 'turn-error', 'turn-max-tokens', 'turn-tail', 'turn-process'])

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

/** Model-work categories used by compact process titles. */
export type ProcessActivity = 'commands' | 'read' | 'edit' | 'search' | 'tools'

function activity(name: string): ProcessActivity {
  if (name === 'bash' || name === 'pwsh') return 'commands'
  if (name === 'read' || name === 'read_image') return 'read'
  if (name === 'edit' || name === 'write') return 'edit'
  if (name === 'grep' || name === 'glob' || name === 'web_search') return 'search'
  return 'tools'
}

/**
 * Count tool calls once, deduplicate known file paths per activity, and omit runtime metadata.
 * @param nodes - process members, including reasoning and infrastructure rows.
 * @returns up to three largest work counts and the latest running tool activity.
 */
// TODO: Refine step-process title rules for live activity, completed-work categories,
// counting, top-three selection, and fallback wording; the current rules are provisional.
export function processActivity(nodes: readonly ChatNode[]): {
  counts: readonly { kind: ProcessActivity; count: number }[]
  running: ProcessActivity | undefined
} {
  const counts = new Map<ProcessActivity, number>()
  const files = new Map<ProcessActivity, Set<string>>()
  const seen = new Set<string>()
  let running: ProcessActivity | undefined
  const visit = (tool: ToolCallBlock): void => {
    if (seen.has(tool.callId)) return
    seen.add(tool.callId)
    const call = isRunningTool(tool) ? tool : tool.call
    if (call !== null) {
      const kind = activity(call.name)
      if (isRunningTool(tool)) running = kind
      let count = true
      if (kind === 'read' || kind === 'edit') {
        let args: unknown
        try { args = JSON.parse(call.argsRaw) } catch { /* Streaming tool arguments may be incomplete JSON. */ }
        if (typeof args === 'object' && args !== null && 'file_path' in args && typeof args.file_path === 'string') {
          const paths = files.get(kind) ?? new Set<string>()
          count = !paths.has(args.file_path)
          paths.add(args.file_path)
          files.set(kind, paths)
        }
      }
      if (count) counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    for (const child of tool.subCalls) visit(child)
  }
  for (const node of nodes) {
    if (node.kind === 'tool-call') visit(node.data.root)
  }
  return {
    counts: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count).slice(0, 3),
    running,
  }
}
