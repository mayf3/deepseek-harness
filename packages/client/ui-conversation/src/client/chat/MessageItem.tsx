// MessageItem: the four simple node kinds — user bubble (right-aligned, with
// clock + copy / branch / edit IconActions), steering (badged bubble), context
// injection and unknown-surface JSON rows. Props are frozen node slices off
// the snapshot cache; memo holds across streaming because unchanged nodes
// keep their references.

import { memo } from 'react'
import type { ReactNode } from 'react'
import type {
  ContextMessageNode, SteeringMessageNode, UnknownSurfaceNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageItem.module.css'

export interface MessageItemProps {
  node: UserMessageNode | SteeringMessageNode | ContextMessageNode | UnknownSurfaceNode
  /** Durable labels from a neighboring session-reference context event. */
  sessionLabels?: readonly string[]
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
function projectUserText(text: string, sessionLabels: readonly string[] = []): ReactNode {
  const exactSessions = [...new Set(sessionLabels)]
    .filter(label => label.length > 0)
    .sort((left, right) => right.length - left.length)
    .map(label => label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  const sessionPattern = exactSessions.length === 0 ? '(?!)' : `@(?:${exactSessions.join('|')})`
  const re = new RegExp(
    `<skill>([^<]+)</skill>|(^|\\s)(?:((?:${sessionPattern})+)|([/@][\\w-]+(?=\\s|$)))`,
    'gu',
  )
  const parts: ReactNode[] = []
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const legacy = m[1] !== undefined
    const tokenStart = legacy ? m.index : m.index + (m[2]?.length ?? 0)
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    const sessionRun = m[3]
    if (sessionRun !== undefined) {
      const sessionRe = new RegExp(sessionPattern, 'gu')
      let session: RegExpExecArray | null
      while ((session = sessionRe.exec(sessionRun)) !== null) {
        const start = tokenStart + session.index
        parts.push(
          <span key={start} className={css.refChip} data-ref-chip="reference">
            {session[0]}
          </span>,
        )
      }
      cursor = tokenStart + sessionRun.length
      continue
    }
    const label = legacy ? `/${m[1]}` : m[4] ?? ''
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

function UserBubble({
  text,
  rest,
  sessionLabels,
  steering,
}: {
  text: string
  rest: readonly unknown[]
  sessionLabels: readonly string[]
  steering?: boolean
}): ReactNode {
  return (
    <div className={css.userStack}>
      <div className={css.bubble}>
        {steering === true ? <span className={css.badge}>插话</span> : null}
        {projectUserText(text, sessionLabels)}
        {rest.map((block, i) => <JsonBlock key={i} label="附加内容块" payload={block} />)}
      </div>
      {sessionLabels.length > 0
        ? <div className={css.referenceSummary}>引用会话 · {sessionLabels.join(', ')}</div>
        : null}
    </div>
  )
}

export const MessageItem = memo(function MessageItem({ node, sessionLabels = [] }: MessageItemProps) {
  switch (node.kind) {
    case 'user': {
      const { text, rest } = contentText(node.content)
      return (
        <div className={css.userRow}>
          <UserBubble text={text} rest={rest} sessionLabels={sessionLabels} />
          <MessageIconActions
            text={text}
            time={node.time}
            clock="start"
            edit
            className={css.actions}
          />
        </div>
      )
    }
    case 'steering': {
      const { text, rest } = contentText(node.content)
      return (
        <div className={css.userRow}>
          <UserBubble text={text} rest={rest} sessionLabels={sessionLabels} steering />
        </div>
      )
    }
    case 'context':
      return (
        <ContextInjectionRow content={node.content} source={node.source} />
      )
    default:
      return (
        <div className={css.contextRow}>
          <JsonBlock label={`未知 surface 事件：${node.type}`} payload={node.data} />
        </div>
      )
  }
})
