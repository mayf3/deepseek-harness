import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'

/** One loaded Turn projected into the compact Chat navigation rail. */
export interface TurnNavigationItem {
  readonly turn: number
  readonly anchorKey: string
  readonly prompt: string
  readonly response: string
}

function compactText(parts: readonly string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function promptText(node: ChatNode): string {
  if (node.kind !== 'user') return ''
  return compactText(node.data.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

function responseText(node: ChatNode): string {
  if (node.kind !== 'assistant-step') return ''
  return compactText(node.data.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []))
}

/**
 * Project the currently loaded Chat window into stable Turn navigation items.
 * @param snapshot - current incremental Chat snapshot.
 * @returns loaded Turns that have at least one visible rendered anchor.
 */
export function deriveTurnNavigationItems(
  snapshot: Pick<ChatSnapshot, 'timeline' | 'locations' | 'nodes'>,
): readonly TurnNavigationItem[] {
  return snapshot.timeline.turnOrder.flatMap((turn): TurnNavigationItem[] => {
    const nodes = snapshot.locations.getTurn(turn)
      .map(key => snapshot.nodes.get(key))
      .filter((node): node is ChatNode => node !== undefined && node.visibility === 'visible')
    const user = nodes.find(node => node.kind === 'user')
    const anchor = user ?? nodes[0]
    if (anchor === undefined) return []
    const response = nodes.findLast(node => responseText(node) !== '')
    return [{
      turn,
      anchorKey: anchor.key,
      prompt: user === undefined ? '' : promptText(user),
      response: response === undefined ? '' : responseText(response),
    }]
  })
}
