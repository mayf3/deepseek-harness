/** Browser plugin for the Agent Teams roster, task board, and Team-routed teammate navigation. */

import teamsRemote from '@deepseek-ai/dsh-team/remote'
import type {
  TeamMemberView as TeamRosterMember,
  TeamTaskView as TeamTask,
  TeamView,
} from '@deepseek-ai/dsh-team/client'
import type {} from '@deepseek-ai/dsh-team/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { TeamAction, type TeamActionInjected, type TeamActionResult } from './TeamAction.tsx'
import { en, zh, type TeamKey } from './locales.ts'

export type { TeamActionInjected, TeamActionProps, TeamActionResult } from './TeamAction.tsx'
export type { TeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Teams roster and task-board copy. */
    team: TeamKey
  }
}

/** Required browser services for RPC, navigation, slots, and localized copy. */
export const inject = ['sessions', 'remote', 'slots', 'locale']

function registerUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('team', { zh, en }), 'ui-team: dictionaries')
  const sessions = ctx.sessions
  const leadSessionId = (sessionId: SessionId): SessionId => {
    const address = sessions.binding(sessionId)?.session.getSnapshot().subagent?.address
    return address?.parentSessionId ?? sessionId
  }

  const actions: TeamActionInjected = {
    async load(sessionId): Promise<TeamActionResult<TeamView>> {
      return await ctx.remote.teams.view(leadSessionId(sessionId))
    },
    async createTask(sessionId, input): Promise<TeamActionResult<TeamTask>> {
      return await ctx.remote.teams.createTask(leadSessionId(sessionId), input)
    },
    async updateTask(sessionId, input) {
      const { owner, ...rest } = input
      return await ctx.remote.teams.updateTask(leadSessionId(sessionId), {
        ...rest,
        ...owner === undefined ? {} : { owner },
      })
    },
    async openTeammate(sessionId: SessionId, member: TeamRosterMember): Promise<void> {
      if (member.role !== 'teammate') return
      const parentSessionId = leadSessionId(sessionId)
      await sessions.refreshSubagents(parentSessionId)
      if (sessions.list.getSnapshot().current !== sessionId) return
      sessions.openSubagent({
        parentSessionId,
        childSessionId: member.id,
        mode: 'continuable',
      })
    },
  }

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-team',
      order: 20,
      locale: 'team',
      inject: () => actions,
    }, TeamAction),
  )
}

/** Mount the generated Team Remote contribution, then register its browser UI. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(teamsRemote)
  const ui = ctx.inject(['sessions', 'remote.teams', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
