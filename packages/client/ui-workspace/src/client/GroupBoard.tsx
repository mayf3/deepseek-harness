import { useMemo, useState } from 'react'
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconCloseOutline16, IconPlusOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import { groupAccountKey } from './group-keys.ts'
import type { SessionMeta } from './stores.ts'
import { deriveFlat } from './tree.ts'
import css from './GroupBoard.module.css'

interface DragState {
  sessionId: SessionId
  sourceGroup: string | undefined
  targetGroup: string | undefined
  beforeId: SessionId | undefined
}

interface BoardColumn {
  key: string
  group: string | undefined
  label: string
  rows: ReturnType<typeof deriveFlat>
}

type Translate = WorkspaceBrowserProps['t']

function reconcileRows(
  rows: ReturnType<typeof deriveFlat>,
  stored: readonly string[] | undefined,
): ReturnType<typeof deriveFlat> {
  const byId = new Map(rows.map(row => [row.id, row]))
  const seen = new Set<string>()
  const ordered: ReturnType<typeof deriveFlat> = []
  for (const id of stored ?? []) {
    const row = byId.get(id as SessionId)
    if (row !== undefined && !seen.has(id)) {
      seen.add(id)
      ordered.push(row)
    }
  }
  for (const row of rows) {
    if (!seen.has(row.id)) ordered.push(row)
  }
  return ordered
}

function cardStatus(row: ReturnType<typeof deriveFlat>[number], t: Translate): { label: string; state: string } {
  if (row.pendingInteraction === 'approval') return { label: t('status.waitingApproval'), state: 'waiting' }
  if (row.pendingInteraction === 'plan-review') return { label: t('status.planReview'), state: 'waiting' }
  if (row.pendingInteraction === 'question') return { label: t('status.waitingAnswer'), state: 'waiting' }
  if (row.running) return { label: t('status.running'), state: 'running' }
  if (row.unread) return { label: t('status.unread'), state: 'unread' }
  if (row.completed) return { label: t('status.completed'), state: 'completed' }
  return { label: t('status.idle'), state: 'idle' }
}

/**
 * Render the full-width user-group task board.
 * @param props - framework session hook, persisted grouping/order state, and callbacks.
 * @returns controlled full-viewport modal.
 */
export function GroupBoard({
  open, onClose, useSessions, workspaces, archivedSessionIds, sessionMeta, knownGroups,
  sessionOrderByAccount, setSessionGroup, setSessionOrder, removeGroup,
  onOpenSession, onAddGroup, t,
}: {
  open: boolean
  onClose: () => void
  useSessions: WorkspaceBrowserProps['useSessions']
  workspaces: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
  sessionMeta: Readonly<Record<string, SessionMeta>>
  knownGroups: readonly string[]
  sessionOrderByAccount: Readonly<Record<string, readonly string[]>>
  setSessionGroup: (sessionId: string, group: string | undefined) => void
  setSessionOrder: (accountKey: string, order: string[]) => void
  removeGroup: (group: string) => void
  onOpenSession: (sessionId: SessionId) => void
  onAddGroup: () => void
  t: Translate
}) {
  const list = useSessions(state => state)
  const [drag, setDrag] = useState<DragState | null>(null)
  const rows = useMemo(
    () => deriveFlat(list, workspaces, archivedSessionIds, sessionMeta),
    [list, workspaces, archivedSessionIds, sessionMeta],
  )
  const workspaceNames = useMemo(() => {
    const names = new Map<WorkspaceId, string>()
    for (const workspace of workspaces) names.set(workspace.workspaceId, workspace.title)
    return names
  }, [workspaces])
  const columns = useMemo((): BoardColumn[] => {
    const names = new Set(knownGroups)
    for (const row of rows) if (row.group !== undefined) names.add(row.group)
    const named = [...names].sort((a, b) => a.localeCompare(b)).map((group): BoardColumn => {
      const key = groupAccountKey(group)
      return {
        key,
        group,
        label: group,
        rows: reconcileRows(rows.filter(row => row.group === group), sessionOrderByAccount[key]),
      }
    })
    const key = groupAccountKey(undefined)
    named.push({
      key,
      group: undefined,
      label: t('board.unassigned'),
      rows: reconcileRows(rows.filter(row => row.group === undefined), sessionOrderByAccount[key]),
    })
    return named
  }, [knownGroups, rows, sessionOrderByAccount, t])

  const commitDrop = (targetGroup: string | undefined, beforeId: SessionId | undefined): void => {
    if (drag === null) return
    const source = columns.find(column => column.group === drag.sourceGroup)
    const target = columns.find(column => column.group === targetGroup)
    if (source === undefined || target === undefined) return
    const sourceIds = source.rows.map(row => row.id).filter(id => id !== drag.sessionId)
    const targetIds = target.rows.map(row => row.id).filter(id => id !== drag.sessionId)
    const insertAt = beforeId === undefined ? targetIds.length : Math.max(0, targetIds.indexOf(beforeId))
    targetIds.splice(insertAt, 0, drag.sessionId)
    if (source.group === target.group) {
      setSessionOrder(target.key, targetIds.map(id => id as string))
    } else {
      setSessionGroup(drag.sessionId, target.group)
      setSessionOrder(source.key, sourceIds.map(id => id as string))
      setSessionOrder(target.key, targetIds.map(id => id as string))
    }
    setDrag(null)
  }

  return (
    <Modal open={open} onClose={onClose} title={t('board.title')} closeLabel={t('board.close')} headless className={css.dialog ?? ''}>
      <div className={css.root}>
        <header className={css.header}>
          <div>
            <h2 className={css.title}>{t('board.title')}</h2>
            <p className={css.hint}>{t('board.hint')}</p>
          </div>
          <div className={css.headerActions}>
            <button type="button" className={css.addButton} onClick={onAddGroup}>
              <IconPlusOutline16 size={15} />
              {t('board.addGroup')}
            </button>
            <button type="button" className={css.closeButton} aria-label={t('board.close')} onClick={onClose}>
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </header>
        <div className={css.columns} role="region" aria-label={t('board.title')}>
          {columns.map(column => (
            <section
              key={column.key}
              className={css.column}
              data-drop={drag?.targetGroup === column.group || undefined}
              onDragOver={(event) => {
                if (drag === null) return
                event.preventDefault()
                setDrag(current => current === null ? current : { ...current, targetGroup: column.group, beforeId: undefined })
              }}
              onDrop={(event) => {
                event.preventDefault()
                commitDrop(column.group, drag?.beforeId)
              }}
            >
              <div className={css.columnHeader}>
                <span className={css.columnTitle}>{column.label}</span>
                <span className={css.count}>{column.rows.length}</span>
                {column.group !== undefined && (
                  <button
                    type="button"
                    className={css.deleteButton}
                    aria-label={t('menu.deleteGroup')}
                    title={t('menu.deleteGroup')}
                    onClick={() => { removeGroup(column.group as string) }}
                  >
                    <IconTrashOutline16 size={14} />
                  </button>
                )}
              </div>
              <div className={css.cards}>
                {column.rows.length === 0 && <div className={css.empty}>{t('board.empty')}</div>}
                {column.rows.map((row) => {
                  const status = cardStatus(row, t)
                  return (
                    <article
                      key={row.id}
                      className={css.card}
                      data-marker={drag?.targetGroup === column.group && drag?.beforeId === row.id || undefined}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', row.id)
                        setDrag({ sessionId: row.id, sourceGroup: row.group, targetGroup: column.group, beforeId: undefined })
                      }}
                      onDragOver={(event) => {
                        if (drag === null) return
                        event.preventDefault()
                        event.stopPropagation()
                        const rect = event.currentTarget.getBoundingClientRect()
                        const index = column.rows.findIndex(item => item.id === row.id)
                        const beforeId = event.clientY < rect.top + rect.height / 2
                          ? row.id
                          : column.rows[index + 1]?.id
                        setDrag(current => current === null ? current : { ...current, targetGroup: column.group, beforeId })
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        commitDrop(column.group, drag?.beforeId)
                      }}
                      onDragEnd={() => { setDrag(null) }}
                      onClick={() => { onOpenSession(row.id); onClose() }}
                    >
                      <div className={css.cardTitle}>{row.blank ? t('session.new') : row.title}</div>
                      <div className={css.cardMeta}>
                        <span className={css.status} data-state={status.state}>
                          <i />{status.label}
                        </span>
                        <span>{row.workspaceId === undefined
                          ? t('group.ungrouped')
                          : workspaceNames.get(row.workspaceId) ?? t('group.ungrouped')}</span>
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  )
}
