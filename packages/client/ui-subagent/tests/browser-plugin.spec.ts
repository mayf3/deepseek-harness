/** Browser plugin registration for the subagent catalog and composer seats. */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  SlotsService, type ConversationSnapshot, type SessionId, type SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyLocale } from '@deepseek-ai/dsh-client-locale/client'
import {
  SubagentCatalogAction, type SubagentCatalogInjected,
} from '../src/client/SubagentCatalogAction.tsx'
import {
  SubagentReadOnlyComposer, type SubagentReadOnlyMatch,
} from '../src/client/SubagentReadOnlyComposer.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const sid = (id: string) => id as SessionId

function sessionsFace() {
  const actionCalls: { method: string; args: unknown[] }[] = []
  return {
    actionCalls,
    openSubagent: (address: SubagentAddress) => {
      actionCalls.push({ method: 'openSubagent', args: [address] })
    },
    refreshSubagents: (parentSessionId: SessionId) => {
      actionCalls.push({ method: 'refreshSubagents', args: [parentSessionId] })
      return Promise.resolve()
    },
    setSubagentCatalogOpen: (parentSessionId: SessionId, open: boolean) => {
      actionCalls.push({ method: 'setSubagentCatalogOpen', args: [parentSessionId, open] })
    },
  }
}

async function provideSlotFaces(ctx: Context): Promise<void> {
  await ctx.plugin(SlotsService).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
    },
  } as never, () => null)
}

async function bench() {
  const ctx = new Context()
  const face = sessionsFace()
  ctx.provide('sessions', face)
  await provideSlotFaces(ctx)
  await ctx.plugin({ inject: ['slots'], apply: applyLocale }).await()
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { face, ctx }
}

describe('apply', () => {
  it('exposes a no-op Host half for Loader discovery', () => {
    expect(nodeApply).not.toThrow()
  })

  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'slots', 'locale'])
  })

  it('registers catalog actions and selects read-only subagent composers from session facts', async () => {
    const { ctx, face } = await bench()
    const catalogEntry = ctx.slots.entries('conversation.session.header.actions')
      .find(entry => entry.component === SubagentCatalogAction)!
    const actions = (catalogEntry.inject as unknown as (id: SessionId) => SubagentCatalogInjected)(sid('parent'))
    const address: SubagentAddress = {
      parentSessionId: sid('parent'),
      childSessionId: sid('c1'),
      mode: 'continuable',
    }
    actions.openChild(address)
    actions.refresh(sid('parent'))
    actions.setCatalogOpen(sid('parent'), true)
    expect(face.actionCalls).toEqual([
      { method: 'openSubagent', args: [address] },
      { method: 'refreshSubagents', args: [sid('parent')] },
      { method: 'setSubagentCatalogOpen', args: [sid('parent'), true] },
    ])

    const composerEntry = ctx.slots.entries('conversation.composer')
      .find(entry => entry.component === SubagentReadOnlyComposer)!
    const select = composerEntry.select as (owner: ComposerChainProps) => SubagentReadOnlyMatch | null
    const owner = (
      subagent: ConversationSnapshot['subagent'] | undefined,
    ): ComposerChainProps => ({
      interactions: [],
      session: subagent === undefined
        ? undefined
        : ({ subagent } as unknown as ConversationSnapshot),
    })
    expect(select(owner(undefined))).toBeNull()
    expect(select(owner(null))).toBeNull()
    expect(select(owner({ address: { ...address, mode: 'one-shot' }, parentAvailable: true })))
      .toEqual({ reason: 'one-shot' })
    expect(select(owner({ address, parentAvailable: true }))).toBeNull()
    expect(select(owner({ address, parentAvailable: false })))
      .toEqual({ reason: 'parent-unavailable' })
  })
})
