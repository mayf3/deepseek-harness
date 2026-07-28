/**
 * Chat flow derivation: ConversationSnapshot nodes -> render items. Tool
 * results group into consecutive-run tool groups (figma step-summary flow,
 * VERTICAL gap10) alternating with narration; everything else passes through.
 * Item identity keys are stable across snapshots so the list parent can
 * subscribe to keys only while rows subscribe to content.
 */
import type { ConversationNode, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'

/** One renderable flow item; key is the React key and the parent's identity unit. */
export type ChatFlowItem =
  | {
    kind: 'node'
    key: string
    node: ConversationNode
    /** Session-reference labels attached to the neighboring direct message. */
    sessionLabels?: readonly string[]
  }
  | { kind: 'tool-group'; key: string; results: readonly ToolResultNode[] }

function sessionReferenceLabels(node: ConversationNode): string[] | undefined {
  if (node.kind !== 'context' || typeof node.source !== 'object' || node.source === null) return undefined
  const source = node.source as { kind?: unknown; references?: unknown }
  if (source.kind !== 'session-reference' || !Array.isArray(source.references)) return undefined
  const labels = source.references.flatMap((reference): string[] => {
    if (typeof reference !== 'object' || reference === null) return []
    const value = reference as { label?: unknown; sessionId?: unknown }
    if (typeof value.label === 'string') return [value.label]
    return typeof value.sessionId === 'string' ? [value.sessionId] : []
  })
  return labels.length === 0 ? undefined : labels
}

function acceptsSessionReferences(node: ConversationNode): boolean {
  return node.kind === 'user' || node.kind === 'steering'
}

/**
 * Group finalized nodes into the step-summary flow.
 * @param nodes - snapshot nodes (surface order).
 * @returns flow items; consecutive tool-results merged into one group keyed by the first seq.
 */
export function deriveChatFlow(nodes: readonly ConversationNode[]): ChatFlowItem[] {
  const items: ChatFlowItem[] = []
  let group: ToolResultNode[] | null = null
  let pendingReference: { node: ConversationNode; labels: readonly string[] } | undefined
  for (const node of nodes) {
    const referenceLabels = sessionReferenceLabels(node)
    if (referenceLabels !== undefined) {
      const previous = items.at(-1)
      if (
        previous?.kind === 'node'
        && acceptsSessionReferences(previous.node)
        && pendingReference === undefined
      ) {
        previous.sessionLabels = referenceLabels
      } else {
        if (pendingReference !== undefined) {
          items.push({
            kind: 'node',
            key: `n${pendingReference.node.seq}`,
            node: pendingReference.node,
          })
        }
        pendingReference = { node, labels: referenceLabels }
      }
      group = null
      continue
    }
    if (pendingReference !== undefined) {
      if (acceptsSessionReferences(node)) {
        items.push({
          kind: 'node',
          key: `n${node.seq}`,
          node,
          sessionLabels: pendingReference.labels,
        })
        pendingReference = undefined
        group = null
        continue
      }
      items.push({
        kind: 'node',
        key: `n${pendingReference.node.seq}`,
        node: pendingReference.node,
      })
      pendingReference = undefined
    }
    if (node.kind === 'tool-result') {
      if (group === null) {
        group = [node]
        items.push({ kind: 'tool-group', key: `g${node.seq}`, results: group })
      } else {
        group.push(node)
      }
    } else {
      group = null
      items.push({ kind: 'node', key: `n${node.seq}`, node })
    }
  }
  if (pendingReference !== undefined) {
    items.push({
      kind: 'node',
      key: `n${pendingReference.node.seq}`,
      node: pendingReference.node,
    })
  }
  return items
}

/**
 * Key projection for the list parent's selector (content-blind identity).
 * @param items - derived flow items.
 * @returns joined key string usable with Object.is short-circuiting.
 */
export function flowKeys(items: readonly ChatFlowItem[]): string {
  return items.map(i => i.key).join('|')
}
