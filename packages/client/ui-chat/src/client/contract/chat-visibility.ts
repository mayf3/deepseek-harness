/** Chat-only row visibility; durable events and trajectory inspection remain intact. */
import type { ChatNode } from './chat-nodes.ts'

/**
 * Exclude infrastructure rows while retaining independent turn-trigger notices.
 * @param node - projected Chat node.
 * @returns whether the node contributes a visible Chat row.
 */
export function isVisibleChatNode(node: ChatNode): boolean {
  return node.visibility === 'visible'
    && node.kind !== 'system-prompt'
    && node.kind !== 'context'
    && !(node.kind === 'command' && node.data.name === 'permission')
}
