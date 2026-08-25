/**
 * Task-list plugin, browser half: contributes one session-header action that
 * renders this session's tasks — background jobs joined with their correlated
 * live-output activities, plus standalone activities such as workflow runs.
 * Job rows arrive through the `jobsBySession` list mirror; activity rows and
 * per-row observation streams arrive through the `activityFeed` client
 * service. This plugin holds no transport state of its own.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ActivityListAction } from './ActivityListAction.tsx'
import type { ActivityListInjected } from './ActivityListAction.tsx'
import type {} from '@deepseek-ai/dsh-api-activity-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { en, NS, zh, type ActivityKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Live-activity list copy. */
    'activity': ActivityKey
  }
}

export type { ActivityListActionProps, ActivityListInjected } from './ActivityListAction.tsx'

/** Required services: session and activity state, the slot registry, and dictionaries. */
export const inject = ['sessions', 'activityFeed', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-activity: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'activity-list',
      // After the subagent catalog: session lineage reads before running work.
      order: 20,
      locale: NS,
      inject: (): ActivityListInjected => ({
        hooks: { activity: ctx.activityFeed.state },
        observe: id => ctx.activityFeed.observe(id),
      }),
    }, ActivityListAction),
  )
}
