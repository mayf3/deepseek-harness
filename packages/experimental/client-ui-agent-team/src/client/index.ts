/** Browser plugin for the Agent Teams roster, task board, and Team-routed teammate navigation. */

import type {} from '@deepseek-ai/dsh-agent-team-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  TeamMemberView as TeamRosterMember,
  TeamTaskMutationResult,
  TeamTaskView as TeamTask,
  TeamView,
} from '@deepseek-ai/dsh-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
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
export const inject = ['sessions', 'remote', 'remote.teams', 'slots', 'locale']

function settle<T>(result: RemoteResult<T>): TeamActionResult<T> {
  if (result.ok) return { ok: true, value: result.value }
  return {
    ok: false,
    error: `${result.error.message} (${result.error.code})`,
    conflict: result.error.code === 'team-task-conflict',
  }
}

function settleMutation(result: RemoteResult<TeamTaskMutationResult>): TeamActionResult<TeamTask> {
  if (!result.ok) return settle(result)
  if (result.value.ok) return { ok: true, value: result.value.value }
  return {
    ok: false,
    error: `${result.value.error.message} (${result.value.error.code})`,
    conflict: result.value.error.code === 'team-task-conflict',
  }
}

/** Register the Team conversation-header action and its RPC-backed business face. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('team', { zh, en }), 'ui-team: dictionaries')
  const sessions = ctx.sessions
  const leadSessionId = (sessionId: SessionId): SessionId => {
    const address = sessions.binding(sessionId)?.session.getSnapshot().subagent?.address
    return address?.parentSessionId ?? sessionId
  }

  const actions: TeamActionInjected = {
    async load(sessionId): Promise<TeamActionResult<TeamView>> {
      return settle(await ctx.remote.teams.view(leadSessionId(sessionId)))
    },
    async createTask(sessionId, input): Promise<TeamActionResult<TeamTask>> {
      return settle(await ctx.remote.teams.createTask(leadSessionId(sessionId), input))
    },
    async updateTask(sessionId, input): Promise<TeamActionResult<TeamTask>> {
      const { owner, ...rest } = input
      return settleMutation(await ctx.remote.teams.updateTask(leadSessionId(sessionId), {
        ...rest,
        ...owner === undefined ? {} : { owner },
      }))
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
