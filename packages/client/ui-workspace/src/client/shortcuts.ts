/** Workspace command registration and browser-owned opening requests. */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCommand, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UiWorkspace } from './navigation.ts'

/** Transient requests consumed by the existing workspace browser. */
export interface WorkspaceShortcutState {
  readonly searchRequest: number
  readonly addRequested: boolean
  readonly directoryBusy: boolean
  readonly renameTarget: { readonly sessionId: SessionId; readonly currentTitle: string } | null
}

interface WorkspaceShortcutControls {
  state: SnapshotStore<WorkspaceShortcutState>
  search: () => void
  add: () => void
  closeAdd: () => void
  directoryBusy: (busy: boolean) => void
  rename: (sessionId: SessionId, currentTitle: string) => void
  closeRename: () => void
}

/**
 * Create the private browser request source shared by commands and controls.
 * @returns observable state and its complete mutation callbacks.
 */
export function createWorkspaceShortcutControls(): WorkspaceShortcutControls {
  const state = createSnapshotStore<WorkspaceShortcutState>({
    searchRequest: 0, addRequested: false, directoryBusy: false, renameTarget: null,
  })
  return {
    state,
    search: () => { state.set({ ...state.getSnapshot(), searchRequest: state.getSnapshot().searchRequest + 1 }) },
    add: () => { state.set(state.getSnapshot().directoryBusy ? state.getSnapshot() : { ...state.getSnapshot(), addRequested: true }) },
    closeAdd: () => { state.set({ ...state.getSnapshot(), addRequested: false }) },
    directoryBusy: (busy: boolean) => { state.set({ ...state.getSnapshot(), directoryBusy: busy }) },
    rename: (sessionId: SessionId, currentTitle: string) => {
      state.set({ ...state.getSnapshot(), renameTarget: { sessionId, currentTitle } })
    },
    closeRename: () => { state.set({ ...state.getSnapshot(), renameTarget: null }) },
  }
}

/**
 * Register navigation commands against the existing workspace owner.
 * @param ctx - plugin context with the shortcut, locale, and model services.
 * @param navigation - the same navigation service used by pointer controls.
 * @param controls - browser-owned opening requests.
 * @param archiveSession - shared archive action, including running-work confirmation and notices.
 */
export function installWorkspaceShortcuts(
  ctx: Context,
  navigation: UiWorkspace,
  controls: ReturnType<typeof createWorkspaceShortcutControls>,
  archiveSession: (sessionId: SessionId) => void,
): void {
  const t = ctx.locale.bind('workspace')
  const current = () => Object.values(ctx.sessions.list.getSnapshot().byId)
    .find(row => (row.retainedBy.mainView ?? 0) > 0)
  const reasons = {
    main: () => current() === undefined ? t('shortcut.noSession') : null,
    add: () => ctx.slots.entries('sidebar.workspaces.directoryFlow').length === 0
      ? t('shortcut.noPicker')
      : controls.state.getSnapshot().directoryBusy ? t('shortcut.directoryBusy') : null,
  }
  const timeline = () => {
    const row = current()
    const binding = row === undefined ? undefined : ctx.sessions.binding(row.id)
    return binding === undefined ? undefined : ctx.uiConversation.binding(binding).timeline
  }
  const forkTarget = () => {
    const row = current()
    const snapshot = timeline()?.getSnapshot()
    if (row === undefined || snapshot === undefined) return undefined
    for (const turn of [...snapshot.turnOrder].reverse()) {
      const end = snapshot.turns.get(turn)?.end
      if (end !== undefined) return { sessionId: row.id, atSeq: end.seq }
    }
    return undefined
  }
  ctx.effect(() => {
    let active: SessionBinding | undefined
    let stopSession: (() => void) | undefined
    let stopTimeline: (() => void) | undefined
    let disposed = false
    const pending = new Set<SessionBinding>()
    const attempted = new WeakMap<SessionBinding, number | undefined>()
    const completeHistory = (): void => {
      const binding = active
      if (binding === undefined || pending.has(binding)) return
      const state = binding.session.getSnapshot()
      if (state.openState !== 'open' || state.loadingOlder || !state.hasMore || forkTarget() !== undefined) return
      const first = ctx.uiConversation.binding(binding).historyStart.getSnapshot()
      if (attempted.has(binding) && attempted.get(binding) === first) return
      pending.add(binding)
      void (async () => {
        while (!disposed && active === binding && forkTarget() === undefined) {
          const before = ctx.uiConversation.binding(binding).historyStart.getSnapshot()
          const state = binding.session.getSnapshot()
          if (state.openState !== 'open' || !state.hasMore || state.loadingOlder) break
          attempted.set(binding, before)
          await binding.session.loadOlder()
          if (ctx.uiConversation.binding(binding).historyStart.getSnapshot() === before) break
        }
      })().catch((error: unknown) => { console.warn('fork history unavailable:', error) })
        .finally(() => { pending.delete(binding) })
    }
    const update = (): void => {
      const row = current()
      const next = row === undefined ? undefined : ctx.sessions.binding(row.id)
      if (next !== active) {
        stopSession?.()
        stopTimeline?.()
        active = next
        stopSession = next?.session.subscribe(completeHistory)
        stopTimeline = next === undefined ? undefined : ctx.uiConversation.binding(next).timeline.subscribe(completeHistory)
      }
      completeHistory()
    }
    const stopList = ctx.sessions.list.subscribe(update)
    update()
    return () => { disposed = true; stopList(); stopSession?.(); stopTimeline?.() }
  }, 'ui-workspace: completed fork history')
  const availability = (read: () => string | null) => ({
    getSnapshot: read,
    subscribe: (listener: () => void) => {
      let source: ObservableSnapshot<ConversationTimelineSnapshot> | undefined
      let stopTimeline: (() => void) | undefined
      let stopSession: (() => void) | undefined
      const update = () => {
        const next = timeline()
        if (next !== source) {
          stopTimeline?.()
          stopSession?.()
          const row = current()
          stopSession = row === undefined ? undefined : ctx.sessions.binding(row.id)?.session.subscribe(listener)
          source = next
          stopTimeline = next?.subscribe(listener)
        }
        listener()
      }
      const disposers = [ctx.sessions.list.subscribe(update), controls.state.subscribe(listener),
        ctx.locale.subscribe(listener), ctx.slots.subscribe('sidebar.workspaces.directoryFlow', listener)]
      update()
      return () => { stopTimeline?.(); stopSession?.(); for (const dispose of disposers) dispose() }
    },
  })
  const register = (id: string, label: () => string, aliases: string[], code: string,
    modifiers: ('primary' | 'alt' | 'shift')[], resolve: ShortcutCommand['resolve'],
    reason?: () => string | null): void => {
    ctx.effect(() => ctx.shortcuts.register({
      id: id as ShortcutCommandId, label, aliases, defaults: { desktop: { code, modifiers } },
      regions: ['page', 'editable'], modals: [], resolve,
      ...(reason === undefined ? {} : { availability: availability(reason) }),
    }), `ui-workspace: ${id}`)
  }
  register('session.new', () => t('session.new'), ['new session', 'new chat'], 'KeyN', ['primary'],
    () => ({ status: 'handled', run: () => { navigation.startSession() } }))
  register('session.search', () => t('search.sessions.aria'), ['search sessions'], 'KeyK', ['primary'],
    () => ({ status: 'handled', run: controls.search }))
  register('workspace.add', () => t('workspace.add'), ['add workspace', 'open folder'], 'KeyO', ['primary'],
    () => {
      const reason = reasons.add()
      return reason === null ? { status: 'handled', run: controls.add } : { status: 'blocked', reason }
    }, reasons.add)
  register('session.rename', () => t('rename.session.title'), ['rename session'], 'KeyR', ['primary', 'alt'], () => {
    const target = current()
    return target === undefined ? { status: 'blocked', reason: t('shortcut.noSession') }
      : { status: 'handled', run: () => { controls.rename(target.id, target.displayTitle) } }
  }, reasons.main)
  const forkReason = () => {
    if (forkTarget() !== undefined) return null
    const row = current()
    const history = row === undefined ? undefined : ctx.sessions.binding(row.id)?.session.getSnapshot()
    return history?.hasMore || history?.openState === 'loading' ? t('shortcut.loadingHistory') : t('shortcut.noCompletedTurn')
  }
  register('session.fork', () => t('menu.fork'), ['fork session'], 'KeyF', ['primary', 'alt'], () => {
    const target = forkTarget()
    if (target === undefined) return { status: 'blocked', reason: forkReason() ?? t('shortcut.noCompletedTurn') }
    return { status: 'handled', run: () => {
      void navigation.forkSession(target.sessionId, target.atSeq).catch((error: unknown) => { console.warn('session fork rejected:', error) })
    } }
  }, forkReason)
  register('session.archive', () => t('menu.archiveSession'), ['archive session'], 'KeyA', ['primary', 'shift'], () => {
    const target = current()
    return target === undefined ? { status: 'blocked', reason: t('shortcut.noSession') }
      : { status: 'handled', run: () => {
        archiveSession(target.id)
      } }
  }, reasons.main)
}
