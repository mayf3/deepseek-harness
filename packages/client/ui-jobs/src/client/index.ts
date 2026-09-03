/**
 * Background-job plugin, browser half: contributes one session-header action
 * that renders this session's jobs. Job rows arrive through the
 * `jobsBySession` list mirror; per-row observation streams arrive through the
 * `jobOutput` client service. This plugin holds no transport state of its
 * own.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { JobListAction } from './JobListAction.tsx'
import type { JobListInjected } from './JobListAction.tsx'
import type {} from '@deepseek-ai/dsh-api-job-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { en, NS, zh, type JobKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-job list copy. */
    'job': JobKey
  }
}

export type { JobListActionProps, JobListInjected } from './JobListAction.tsx'

/** Required services: session state, job observation, the slot registry, and dictionaries. */
export const inject = ['sessions', 'jobOutput', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-jobs: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'job-list',
      // Between the preset label and the subagent catalog (order 30): running
      // work reads before the session lineage.
      order: 20,
      locale: NS,
      inject: (): JobListInjected => ({
        hooks: { jobOutput: ctx.jobOutput.state },
        observe: (sessionId, id) => ctx.jobOutput.observe(sessionId, id),
      }),
    }, JobListAction),
  )
}
