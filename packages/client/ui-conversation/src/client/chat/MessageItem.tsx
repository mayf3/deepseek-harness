// MessageItem: the four simple node kinds — user bubble (right-aligned),
// steering (badged bubble), context injection and unknown-surface JSON rows.
// Props are frozen node slices off the snapshot cache; memo holds across
// streaming because unchanged nodes keep their references.

import { memo } from 'react'
import type { ReactNode } from 'react'
import type {
  ContextMessageNode, SteeringMessageNode, UnknownSurfaceNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MessageItem.module.css'

export interface MessageItemProps {
  node: UserMessageNode | SteeringMessageNode | ContextMessageNode | UnknownSurfaceNode
}

function contentText(content: readonly unknown[]): { text: string; rest: unknown[] } {
  const texts: string[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else rest.push(block)
  }
  return { text: texts.join(''), rest }
}

/**
 * Decorate legacy skill spans, boundary-delimited plain references, and exact
 * metadata-confirmed session labels in the user bubble. Confirmed labels may
 * touch following prompt text because their durable metadata disambiguates
 * the reference boundary. Logged message text remains unchanged.
 */
function projectUserText(text: string, sessionLabels: readonly string[]): ReactNode {
  const exactSessions = [...new Set(sessionLabels)]
    .filter(label => label.length > 0)
    .sort((left, right) => right.length - left.length)
    .map(label => label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  const sessionPattern = exactSessions.length === 0 ? '' : `@(?:${exactSessions.join('|')})|`
  const re = new RegExp(
    `<skill>([^<]+)</skill>|(^|\\s)(${sessionPattern}[/@][\\w-]+(?=\\s|$))`,
    'gu',
  )
  const parts: ReactNode[] = []
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const legacy = m[1] !== undefined
    const tokenStart = legacy ? m.index : m.index + (m[2]?.length ?? 0)
    const label = legacy ? `/${m[1]}` : m[3] ?? ''
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    parts.push(
      <span key={tokenStart} className={css.refChip} data-ref-chip={label.startsWith('@') ? 'reference' : 'skill'}>
        {label}
      </span>,
    )
    cursor = legacy ? m.index + m[0].length : tokenStart + label.length
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
}

function referencedSessionLabels(
  node: UserMessageNode | SteeringMessageNode,
): string[] {
  const labels: string[] = []
  for (const context of node.prefixContexts ?? []) {
    const meta = context.meta
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)
      || meta.kind !== 'session-reference' || !Array.isArray(meta.references)) continue
    for (const reference of meta.references) {
      if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) continue
      const label = typeof reference.label === 'string'
        ? reference.label
        : typeof reference.sessionId === 'string' ? reference.sessionId : undefined
      if (label !== undefined) labels.push(label)
    }
  }
  return labels
}

export const MessageItem = memo(function MessageItem({ node }: MessageItemProps) {
  switch (node.kind) {
    case 'user':
    case 'steering': {
      const { text, rest } = contentText(node.content)
      const referencedSessions = referencedSessionLabels(node)
      return (
        <div className={css.userRow}>
          <div className={css.userStack}>
            <div className={css.bubble}>
              {node.kind === 'steering' && <span className={css.badge}>插话</span>}
              {projectUserText(text, referencedSessions)}
              {rest.map((block, i) => <JsonBlock key={i} label="附加内容块" payload={block} />)}
            </div>
            {referencedSessions.length > 0
              ? <div className={css.referenceSummary}>引用会话 · {referencedSessions.join(', ')}</div>
              : null}
          </div>
        </div>
      )
    }
    case 'context':
      return (
        <div className={css.contextRow}>
          <JsonBlock label="上下文注入" payload={{ content: node.content, meta: node.meta }} />
        </div>
      )
    default:
      return (
        <div className={css.contextRow}>
          <JsonBlock label={`未知 surface 事件：${node.type}`} payload={node.data} />
        </div>
      )
  }
})
