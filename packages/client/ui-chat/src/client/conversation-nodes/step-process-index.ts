/** Incremental process content over the ordered Chat renderer seats. */
import type { ChatNode } from '../contract/chat-nodes.ts'
import { isVisibleChatNode } from '../contract/chat-visibility.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import type {
  ChatStepProcessIndex, ProcessRange, StepProcessGroup, StepProcessLayout, TurnFooterPresentation,
} from '../contract/step-process.ts'
import { processActivity, processRanges } from './step-process.ts'

type ProcessInput = Pick<ChatSnapshot, 'order' | 'nodes' | 'timeline'>

function sameSeats(left: StepProcessLayout, right: StepProcessLayout | undefined): boolean {
  return right !== undefined && left.key === right.key && left.process === right.process && left.turn === right.turn
    && left.seats.length === right.seats.length && left.seats.every((seat, index) =>
    seat.nodeKey === right.seats[index]?.nodeKey && seat.assistantPart === right.seats[index].assistantPart)
}

function lastContentKind(node: ChatNode | undefined): string | undefined {
  if (node?.kind !== 'assistant-step') return node?.kind
  return node.data.blocks.findLast(block =>
    (block.kind !== 'text' && block.kind !== 'reasoning') || block.text.trim() !== '')?.kind
}

/**
 * Recognize changes to grouping or footer eligibility, excluding body-only chunks.
 * @param previous - previously published Node.
 * @param next - current Node.
 * @returns whether ordered ranges and footer facts need rebuilding.
 */
export function processLayoutChanged(previous: ChatNode | undefined, next: ChatNode): boolean {
  if (previous === undefined || previous.kind !== next.kind || previous.visibility !== next.visibility
    || previous.anchorSeq !== next.anchorSeq || previous.location.kind !== next.location.kind) return true
  const left = previous.location
  const right = next.location
  if ((left.kind === 'turn' || left.kind === 'step') && (right.kind === 'turn' || right.kind === 'step')
    && (left.turn.turn !== right.turn.turn || left.turn.status !== right.turn.status)) return true
  if (previous.kind === 'turn-tail' && next.kind === 'turn-tail') return previous.data.closing !== next.data.closing
  if (previous.kind !== 'assistant-step' || next.kind !== 'assistant-step') return false
  return hasAssistantReplyContent(previous.data.blocks) !== hasAssistantReplyContent(next.data.blocks)
    || previous.data.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '')
      !== next.data.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '')
    || lastContentKind(previous) !== lastContentKind(next)
}

/** Owns stable layout, cached activity, and footer facts for one Chat snapshot builder. */
export class ChatStepProcessProjector implements ChatStepProcessIndex {
  layout: readonly StepProcessLayout[] = []
  private groups = new Map<string, StepProcessGroup>()
  private readonly membership = new Map<string, string[]>()
  private footers = new Map<number, TurnFooterPresentation>()

  get(key: string): StepProcessGroup | undefined { return this.groups.get(key) }
  footer(turn: number): TurnFooterPresentation | undefined { return this.footers.get(turn) }

  /**
   * Rebuild after pagination or a renderer-seat boundary change, preserving unchanged groups.
   * @param input - ordered Nodes and their current Turn lifecycle.
   */
  replace(input: ProcessInput): void {
    const ranges = processRanges(input)
    const groups = new Map<string, StepProcessGroup>()
    this.membership.clear()
    for (const range of ranges) {
      if (!range.process) continue
      groups.set(range.key, this.project(range, input))
      for (const seat of range.seats) {
        const keys = this.membership.get(seat.nodeKey) ?? []
        keys.push(range.key)
        this.membership.set(seat.nodeKey, keys)
      }
    }
    this.groups = groups
    if (ranges.length !== this.layout.length || ranges.some((range, index) => !sameSeats(range, this.layout[index]))) {
      this.layout = ranges
    }
    this.replaceFooters(input)
  }

  /**
   * Refresh only groups containing changed content; historical groups keep their identity.
   * @param input - current keyed Nodes.
   * @param keys - keys changed by this publication.
   */
  update(input: ProcessInput, keys: readonly string[]): void {
    const dirty = new Set<string>()
    for (const key of keys) for (const group of this.membership.get(key) ?? []) dirty.add(group)
    for (const key of dirty) {
      const previous = this.groups.get(key)
      if (previous === undefined) throw new Error(`process membership references missing group ${key}`)
      this.groups.set(key, this.project(previous.range, input))
    }
  }

  private project(range: ProcessRange, input: ProcessInput): StepProcessGroup {
    const nodes = range.seats.map(seat => input.nodes.get(seat.nodeKey) as ChatNode)
    const previous = this.groups.get(range.key)
    const sameNodes = previous !== undefined && previous.nodes.length === nodes.length
      && previous.nodes.every((node, index) => node === nodes[index])
    const sameRange = previous !== undefined && sameSeats(previous.range, range) && previous.range.closed === range.closed
    if (sameNodes && sameRange) return previous
    return {
      range: sameRange ? previous.range : range,
      nodes: sameNodes ? previous.nodes : nodes,
      summary: sameNodes ? previous.summary : processActivity(nodes),
    }
  }

  private replaceFooters(input: ProcessInput): void {
    const turns = new Map<number, ChatNode[]>()
    for (const key of input.order) {
      const node = input.nodes.get(key) as ChatNode
      const location = node.location
      if (location.kind !== 'turn' && location.kind !== 'step') continue
      const nodes = turns.get(location.turn.turn) ?? []
      nodes.push(node)
      turns.set(location.turn.turn, nodes)
    }
    const footers = new Map<number, TurnFooterPresentation>()
    for (const [turn, nodes] of turns) {
      const tail = nodes.find(node => node.kind === 'turn-tail')
      if (tail?.kind !== 'turn-tail') continue
      const hasLaterChatNode = nodes.some(node => node.kind !== 'turn-tail' && node.kind !== 'turn-max-tokens'
        && node.anchorSeq > (tail.data.closing?.finalNode.seq ?? tail.data.seq))
      const last = nodes.findLast(node => isVisibleChatNode(node) && node.kind !== 'turn-tail' && node.kind !== 'turn-process')
      const block = last?.kind === 'assistant-step' ? last.data.blocks.findLast(candidate =>
        (candidate.kind !== 'text' && candidate.kind !== 'reasoning') || candidate.text.trim() !== '') : undefined
      const endsWithResponse = block !== undefined && hasAssistantReplyContent([block])
      const previous = this.footers.get(turn)
      footers.set(turn, previous?.hasLaterChatNode === hasLaterChatNode && previous.endsWithResponse === endsWithResponse
        ? previous : { hasLaterChatNode, endsWithResponse })
    }
    this.footers = footers
  }
}
