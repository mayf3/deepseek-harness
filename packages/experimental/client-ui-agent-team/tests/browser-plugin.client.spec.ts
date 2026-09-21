import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TeamMemberProjection } from '@deepseek-ai/dsh-experimental-agent-team/client'
import { TeamAction, type TeamActionInjected } from '../src/client/TeamAction.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const SESSION = 'team-session' as SessionId
const CHILD = 'team-child' as SessionId
const LEAD: TeamMemberProjection = { id: SESSION, name: 'lead', role: 'lead', phase: 'active' }
const WORKER: TeamMemberProjection = { id: CHILD, name: 'worker', role: 'teammate', phase: 'active' }

async function bench(options: { addressed?: boolean } = {}) {
  const ctx = new Context()
  const navigation: unknown[] = []
  let mainSessionId = options.addressed === true ? CHILD : SESSION
  ctx.provide('sessions', {
    binding: (id: SessionId) => options.addressed === true && id === CHILD
      ? { session: { getSnapshot: () => ({
        subagent: {
          address: {
            parentSessionId: SESSION,
            childSessionId: CHILD,
            mode: 'continuable' as const,
          },
        },
      }) } }
      : undefined,
    refreshProjections: (id: SessionId) => {
      navigation.push(['refresh', id])
      return Promise.resolve()
    },
    retainInfo: (id: SessionId) => ({
      getSnapshot: () => ({
        referenceCount: id === mainSessionId ? 1 : 0,
        retainedBy: id === mainSessionId ? { mainView: 1 } : {},
      }),
      subscribe: () => () => {},
    }),
  })
  ctx.provide('uiWorkspace', {
    openSession: (target: unknown) => { navigation.push(['open', target]) },
  } as never)
  ctx.provide('conversation', {})
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const collapseHeader = ctx.slots.register({
    name: 'root',
    children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = () => ctx.slots.entries('conversation.session.header.actions')
    .find(candidate => candidate.component === TeamAction)
  const actions = () => (entry()!.inject as unknown as () => TeamActionInjected)()
  return {
    ctx,
    fiber,
    navigation,
    entry,
    actions,
    collapseHeader,
    select: (sessionId: SessionId) => { mainSessionId = sessionId },
  }
}

describe('ui-team browser plugin', () => {
  it('registers one disposable header action without a Team Remote namespace', async () => {
    const b = await bench()
    expect(inject).toEqual(['sessions', 'uiWorkspace', 'slots', 'locale'])
    expect(b.entry()).toMatchObject({
      options: { id: 'agent-team', order: 20 },
      locale: 'agent-team',
    })
    const t = b.ctx.locale.bind('agent-team')
    expect(t('trigger')).toBe('Agent Team')

    b.actions().loadProjections(SESSION)
    expect(b.navigation).toEqual([['refresh', SESSION]])
    b.actions().openTeammate(SESSION, LEAD)
    expect(b.navigation).toEqual([['refresh', SESSION]])

    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(t('empty')).toBe('empty')
  })

  it('opens a continuable teammate address without touching the parent catalog', async () => {
    const b = await bench()
    b.actions().openTeammate(SESSION, WORKER)
    expect(b.navigation).toEqual([
      ['open', { parentSessionId: SESSION, childSessionId: CHILD, mode: 'continuable' }],
    ])
  })

  it('routes teammate navigation from an addressed teammate conversation back through its Lead', async () => {
    const b = await bench({ addressed: true })
    b.actions().openTeammate(CHILD, WORKER)
    expect(b.navigation).toEqual([
      ['open', { parentSessionId: SESSION, childSessionId: CHILD, mode: 'continuable' }],
    ])
  })

  it('does not open a teammate from a conversation outside the main view', async () => {
    const b = await bench()
    b.select('other-session' as SessionId)
    b.actions().openTeammate(SESSION, WORKER)
    expect(b.navigation).toEqual([])
  })

  it('re-registers after the conversation header slot is collapsed and declared again', async () => {
    const b = await bench()
    expect(b.entry()).toBeDefined()
    b.collapseHeader()
    expect(b.entry()).toBeUndefined()
    b.ctx.slots.register({
      name: 'root',
      children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(b.entry()).toBeDefined()
  })

  it('keeps the node half inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
