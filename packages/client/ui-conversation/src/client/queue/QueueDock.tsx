import type { Context } from '@deepseek-ai/cordis'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { QueueAction } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { useEffect, useId, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronUpOutline14, IconCloseOutline16,
  IconEditOutline16, IconQueueOutline14, IconSendOutline14, IconTrashOutline16, projectUserText, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../locales.ts'
import css from './QueueDock.module.css'

const QUEUE_PREVIEW_CHARS = 200
const EMPTY_QUEUE = [] as const

function previewOf(content: InboxState['next-turn'][number]['content']): string {
  const flat = content
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > QUEUE_PREVIEW_CHARS ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…` : flat
}

function textOf(content: InboxState['next-turn'][number]['content']): string | null {
  if (!content.every(block => block.type === 'text')) return null
  return content.map(block => block.text).join('')
}

/** Queue operations injected by the session-scoped registration. */
export interface QueueDockInjected {
  updateQueue: (itemId: MessageId, action: QueueAction) => Promise<void>
  notify: (level: 'info' | 'error', text: string) => void
}

/** Full props of a dock entry: InputZone owner share + session standard kit + global seat + the locale seat. */
export type QueueDockProps = PropsRuntime<'conversation.input.dock'> & QueueDockInjected & PropsLocale<'conversation'>

/**
 * Queue strip: one item renders directly; multiple items default to a
 * collapsible count header; an empty queue renders nothing.
 */
export function QueueDock({ useSession, useProjection, updateQueue, notify, t }: QueueDockProps) {
  const inbox = useProjection('inbox') as unknown as InboxState | undefined
  const queue = inbox?.['next-turn'] ?? EMPTY_QUEUE
  const running = useSession(s => s.running)
  const queueMutable = useSession(s => s.subagent === null)
  const [editing, setEditing] = useState<{ id: MessageId; text: string } | null>(null)
  const [busy, setBusy] = useState<MessageId | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const listId = useId()

  useEffect(() => {
    if (queue.length === 0 && !collapsed) setCollapsed(true)
    if (editing !== null && (!queueMutable || !queue.some(row => row.id === editing.id))) setEditing(null)
  }, [collapsed, editing, queue, queueMutable])

  if (queue.length === 0) return null

  const interactionActive = queueMutable && (editing !== null || busy !== null)
  const expanded = !collapsed || interactionActive
  const listVisible = queue.length === 1 || expanded

  const applyAction = async (
    itemId: MessageId,
    action: QueueAction,
    failure: string,
  ): Promise<boolean> => {
    setBusy(itemId)
    try {
      await updateQueue(itemId, action)
      return true
    } catch {
      notify('error', failure)
      return false
    } finally {
      setBusy(current => current === itemId ? null : current)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (editing === null || editing.text.trim() === '') return
    if (await applyAction(
      editing.id,
      { kind: 'edit', content: [{ type: 'text', text: editing.text }] },
      t('queue.editFailed'),
    )) setEditing(null)
  }

  return (
    <div className={css.dock} data-queue-dock="">
      <div className={css.panel}>
        {queue.length > 1 && (
          <button
            type="button"
            className={css.header}
            aria-controls={listId}
            aria-expanded={expanded}
            disabled={interactionActive}
            onClick={() => { setCollapsed(value => !value) }}
          >
            <span className={css.lead} aria-hidden><IconQueueOutline14 /></span>
            <span className={css.count}>{t('queue.count', { n: queue.length })}</span>
            <span className={css.chevron} aria-hidden>
              {expanded ? <IconChevronDownOutline14 /> : <IconChevronUpOutline14 />}
            </span>
          </button>
        )}
        <ul id={listId} className={css.list} hidden={!listVisible}>
          {listVisible && queue.map((message) => {
            const text = textOf(message.content)
            return <li key={message.id} className={css.row}>
              {/* Single-item strip has no count header, so the row itself carries the queue glyph. */}
              {queue.length === 1 && <span className={css.lead} aria-hidden><IconQueueOutline14 /></span>}
              {editing?.id === message.id
                ? (
                  <input
                    autoFocus
                    className={css.editor}
                    aria-label={t('queue.edit')}
                    value={editing.text}
                    onChange={(event) => { setEditing({ id: message.id, text: event.currentTarget.value }) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setEditing(null)
                        return
                      }
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void saveEdit()
                      }
                    }}
                  />
                )
                : <span className={css.preview}>{projectUserText(previewOf(message.content), [])}</span>}
              {queueMutable && <div className={css.actions}>
                {editing?.id === message.id
                  ? (
                    <>
                      <Tooltip label={t('queue.save')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.save')}
                          disabled={busy !== null || editing.text.trim() === ''}
                          onClick={() => { void saveEdit() }}
                        >
                          <IconCheckOutline16 size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('queue.cancelEdit')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.cancelEdit')}
                          disabled={busy !== null}
                          onClick={() => { setEditing(null) }}
                        >
                          <IconCloseOutline16 size={14} />
                        </button>
                      </Tooltip>
                    </>
                  )
                  : (
                    <>
                      <Tooltip label={t('queue.edit')} side="bottom" delayMs={500} disabled={text === null}>
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.edit')}
                          // Disabled buttons fire no hover events, so the
                          // unsupported hint stays a native title.
                          title={text === null ? t('queue.edit.unsupported') : undefined}
                          disabled={busy !== null || text === null}
                          onClick={() => {
                            if (text !== null) setEditing({ id: message.id, text })
                          }}
                        >
                          <IconEditOutline16 size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('queue.remove')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.remove')}
                          disabled={busy !== null}
                          onClick={() => {
                            void applyAction(
                              message.id,
                              { kind: 'remove' },
                              t('queue.removeFailed'),
                            )
                          }}
                        >
                          <IconTrashOutline16 size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('queue.steer')} side="bottom" delayMs={500} disabled={!running}>
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.steer')}
                          title={running ? undefined : t('queue.steer.unavailable')}
                          disabled={busy !== null || !running}
                          onClick={() => {
                            void applyAction(
                              message.id,
                              { kind: 'steer' },
                              t('queue.steerFailed'),
                            )
                          }}
                        >
                          <IconSendOutline14 />
                        </button>
                      </Tooltip>
                    </>
                  )}
              </div>}
            </li>
          })}
        </ul>
      </div>
    </div>
  )
}

/** Registers queue actions backed by the session-scoped conversation service. */
export const queueDockEntry = {
  name: 'conversation-queue-dock',
  inject: ['slots', 'conversation', 'sessions'],
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'queue',
      order: 20,
      locale: NS,
      inject: (sessionId: SessionId): QueueDockInjected => {
        const actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) throw new Error(`queue dock: session "${sessionId}" resolved no scope`)
        const conversation = actx.get('conversation')
        if (conversation === undefined) throw new Error('queue dock: conversation service unavailable')
        return {
          updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
          notify: (level, text) => { conversation.input.for(actx).notify(level, text) },
        }
      },
    }, QueueDock))
  },
}
