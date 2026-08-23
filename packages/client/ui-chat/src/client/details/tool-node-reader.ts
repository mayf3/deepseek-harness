import { conversationContextKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatNodeStore, ChatSnapshot, ToolCallBlock } from '../contract/snapshot.ts'

function toolNode(node: ReturnType<ChatNodeStore['get']>): ChatNode<'tool-call'> | undefined {
  return node?.kind === 'tool-call' ? node as ChatNode<'tool-call'> : undefined
}

/**
 * Read one root Tool lifecycle through the internal Chat Node index.
 * @param snapshot - current Conversation snapshot.
 * @param rootCallId - root call identity and Tool Context identity.
 * @returns root lifecycle when it is materialized in the current window.
 */
export function rootToolCall(
  snapshot: ChatSnapshot,
  rootCallId: string,
): ToolCallBlock | undefined {
  return toolNode(snapshot.nodes.get(conversationContextKey('tool-call', rootCallId)))?.data.root
}

/**
 * Find any root or nested Tool lifecycle through the internal Node store.
 * @param snapshot - current Conversation snapshot.
 * @param callId - root or nested call identity.
 * @returns current Tool lifecycle when materialized in the loaded window.
 */
export function findToolCall(snapshot: ChatSnapshot, callId: string): ToolCallBlock | undefined {
  const visit = (block: ToolCallBlock): ToolCallBlock | undefined => {
    if (block.callId === callId) return block
    for (const child of block.subCalls) {
      const found = visit(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const node of snapshot.nodes.values()) {
    const root = toolNode(node)?.data.root
    if (root === undefined) continue
    const found = visit(root)
    if (found !== undefined) return found
  }
  return undefined
}
