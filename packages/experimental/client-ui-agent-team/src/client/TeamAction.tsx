import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberProjection,
  TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import {
  IconCloseOutlineRegular, IconRefreshOutlineRegular, IconUserOutlineRegular, StateDot,
  useAnchoredPosition, useDismissOnOutsidePointer, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamAction.module.css'

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  /** Request another Session's projection baseline once per connection, or retry a failed read. */
  loadProjections: (sessionId: SessionId) => void
  openTeammate: (sessionId: SessionId, member: TeamMemberProjection) => void
}

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>

/** Durable lifecycle overlaid with the member Session's live turn activity. */
type MemberStatus = 'running' | 'inactive' | 'provisioning' | 'failed'

function failureText(error: { readonly code: string; readonly message: string }): string {
  return `${error.message} (${error.code})`
}

function statusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    /* v8 ignore next -- the Team projection omits deleted task tombstones. */
    case 'deleted': return 'status.completed'
  }
}

function memberStatusKey(status: MemberStatus): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
  }
}

function memberDotState(status: MemberStatus): StateDotState {
  switch (status) {
    case 'running':
    case 'provisioning': return 'ongoing'
    case 'inactive': return 'idle'
    case 'failed': return 'error'
  }
}

function taskDotState(task: TeamTask): StateDotState {
  switch (task.status) {
    case 'pending': return task.ready ? 'idle' : 'warning'
    case 'in_progress': return 'ongoing'
    case 'completed': return 'done'
    /* v8 ignore next -- the Team projection omits deleted task tombstones. */
    case 'deleted': return 'idle'
  }
}

type TeamMemberRowProps = Pick<TeamActionProps,
  'sessionId' | 'useProjection' | 'useSessions' | 'useSessionStatus' | 'openTeammate' | 't'
> & {
  member: TeamMemberProjection
  onError: (message: string) => void
}

function TeamMemberRow({
  member, sessionId, useProjection, useSessions, useSessionStatus, openTeammate, onError, t,
}: TeamMemberRowProps) {
  const currentModel = useProjection('modelSelection', value =>
    member.id === sessionId ? value?.next?.model : undefined)
  const otherModel = useSessions(state => member.id === sessionId
    ? undefined
    : state.projectionsBySession[member.id]?.values.modelSelection?.next?.model)
  const running = useSessionStatus(state => state.get(member.id)?.running)
  const summaryRunning = useSessions(state => state.byId[member.id]?.running)
  const status: MemberStatus = member.phase === 'active'
    ? (running ?? summaryRunning) === true ? 'running' : 'inactive'
    : member.phase
  const model = member.id === sessionId ? currentModel : otherModel

  return (
    <button
      type="button"
      className={css.member}
      disabled={member.role === 'lead' || status === 'failed' || status === 'provisioning'}
      title={member.role === 'teammate' ? t('open') : undefined}
      onClick={() => {
        try {
          openTeammate(sessionId, member)
        } catch (reason) {
          onError(String(reason))
        }
      }}
    >
      <StateDot state={memberDotState(status)} />
      <span className={css.memberText}>
        <span>{member.name}</span>
        <small>{t(memberStatusKey(status))}{model === undefined ? '' : ` · ${t('model')}: ${model}`}</small>
        {member.error !== undefined && <small className={css.diagnostic}>{member.error}</small>}
      </span>
    </button>
  )
}

/** Render the Team roster and read-only task board from the Lead Session's `agentTeam` projection. */
export function TeamAction({
  sessionId, useSession, useProjection, useSessions, useSessionStatus, loadProjections, openTeammate, t,
}: TeamActionProps) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16,
  })
  const positioned = position !== null
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  const leadSessionId = useSession(snapshot => snapshot.subagent?.address.parentSessionId) ?? sessionId
  const isLead = leadSessionId === sessionId
  const currentTeam = useProjection('agentTeam')
  const openState = useSession(snapshot => snapshot.openState)
  const openError = useSession(snapshot => snapshot.openError)
  const parentTeam = useSessions(state => isLead
    ? undefined
    : state.projectionsBySession[leadSessionId]?.values.agentTeam)
  const parentState = useSessions(state => isLead
    ? undefined
    : state.projectionsBySession[leadSessionId]?.state)
  const parentError = useSessions(state => isLead
    ? null
    : state.projectionsBySession[leadSessionId]?.error ?? null)
  const team = isLead ? currentTeam : parentTeam
  const readError = isLead
    ? openState === 'error' ? openError : null
    : parentState === 'error' ? parentError : null
  const ready = isLead ? openState === 'open' : parentState === 'ready'
  const members = team?.members

  useEffect(() => {
    setOpen(false)
    setError(null)
  }, [sessionId])

  useEffect(() => {
    if (open && !isLead) loadProjections(leadSessionId)
  }, [open, isLead, leadSessionId, loadProjections])

  useEffect(() => {
    if (!open) return
    for (const member of members ?? []) {
      if (member.id !== sessionId && member.id !== leadSessionId && member.phase === 'active') loadProjections(member.id)
    }
  }, [open, sessionId, leadSessionId, members, loadProjections])

  useLayoutEffect(() => {
    if (open && positioned) panelRef.current?.focus()
  }, [open, positioned])

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const teammates = team?.members.filter(member => member.role === 'teammate') ?? []

  return (
    <div ref={rootRef} className={css.root} data-team-action onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return
      event.preventDefault()
      close()
    }} onBlur={(event) => {
      const target = event.relatedTarget
      if (target instanceof Node && !event.currentTarget.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false)
      }
    }}>
      <button
        type="button"
        ref={triggerRef}
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <IconUserOutlineRegular size={14} />
        <span>{t('trigger')}</span>
        {teammates.length > 0 && <span className={css.count}>{teammates.length}</span>}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={t('trigger')}
          data-team-panel
        >
          <div className={css.toolbar}>
            <strong>{t('trigger')}</strong>
            <span className={css.spacer} />
            <button type="button" className={css.iconButton} aria-label={t('close')} onClick={close}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </div>
          {error !== null && (
            <div className={css.error} role="alert"><StateDot state="error" />{error}</div>
          )}
          {readError !== null && (
            <div className={css.error} role="alert">
              <StateDot state="error" />
              <span className={css.spacer}>{failureText(readError)}</span>
              {!isLead && (
                <button type="button" className={css.iconButton} aria-label={t('retry')} onClick={() => { loadProjections(leadSessionId) }}>
                  <IconRefreshOutlineRegular size={14} />
                </button>
              )}
            </div>
          )}
          {team === undefined && readError === null && (
            <div className={css.notice} role="status">
              <StateDot state={ready ? 'warning' : 'ongoing'} />
              {t(ready ? 'unavailable' : 'loading')}
            </div>
          )}
          {team !== undefined && (
            <>
              {team.failure !== undefined && (
                <div className={css.error} role="alert"><StateDot state="error" />{t('failure', { message: team.failure })}</div>
              )}
              <section>
                <h3>{t('roster')}</h3>
                <div className={css.roster}>
                  {team.members.map(member => (
                    <TeamMemberRow
                      key={member.id}
                      member={member}
                      sessionId={sessionId}
                      useProjection={useProjection}
                      useSessions={useSessions}
                      useSessionStatus={useSessionStatus}
                      openTeammate={openTeammate}
                      onError={setError}
                      t={t}
                    />
                  ))}
                </div>
              </section>
              <section>
                <h3>{t('tasks')}</h3>
                {team.tasks.length === 0 && <div className={css.notice}>{t('empty')}</div>}
                <div className={css.tasks}>
                  {team.tasks.map(task => (
                    <article key={task.id} className={css.task}>
                      <div className={css.taskTitle}>
                        <strong>{task.subject}</strong>
                        <span className={css.taskState}>
                          <StateDot state={taskDotState(task)} />
                          <span>{t(statusKey(task.status))}</span>
                        </span>
                      </div>
                      <p>{task.description}</p>
                      <div className={css.meta}>
                        <span>{task.id}</span>
                        <span>{t('owner')}: {task.ownerName ?? t('unowned')}</span>
                        {task.status === 'pending' && <span>{task.ready ? t('ready') : t('blocked')}</span>}
                        {task.blockedBy.length > 0 && <span>{t('blockedBy')}: {task.blockedBy.join(', ')}</span>}
                        {task.writeScopes.length > 0 && <span>{t('writeScopes')}: {task.writeScopes.join(', ')}</span>}
                        {task.writeScopeWarnings.map(warning => <span key={warning} className={css.warning}>{warning}</span>)}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
