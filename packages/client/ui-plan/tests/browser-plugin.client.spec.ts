/**
 * ui-plan browser half on a real SlotRegistry: the plugin occupies the
 * conversation-declared `conversation.input.plan` single seat with the active
 * plan status chip; the injected face executes /plan off and folds admission
 * outcomes into null (admitted) or a user-visible failure line; teardown
 * empties the seat (HMR safety).
 */
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { PlanChip } from '../src/client/PlanModeControl.tsx'
import type { PlanChipInjected } from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

function providePreview(ctx: Context) {
  const events = new ConversationEventRegistry(ctx)
  ctx.provide('uiConversation', { events })
  const removeResources = vi.fn()
  const removeType = vi.fn()
  ctx.provide('resources', { register: vi.fn(() => removeResources) })
  ctx.provide('sidebarRightTabs', { register: vi.fn(() => removeType) })
  ctx.provide('sidebarRight', { openResourceIn: vi.fn() })
  ctx.provide('remote.session', {})
  return { events, removeResources, removeType }
}

const SID = 's-plan' as SessionId

async function bench() {
  const ctx = new Context()
  const preview = providePreview(ctx)
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'conversation.input.plan': { kind: 'single', scope: 'session' } },
  } as never, () => null)
  const execute = vi.fn((_sessionId: SessionId, _line: string) =>
    Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success' as const } } }))
  const commandsRemote = { execute }
  ctx.provide('remote', { commands: commandsRemote })
  ctx.provide('remote.commands', commandsRemote)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots, execute, ...preview }
}

describe('ui-plan browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.commands', 'remote.session', 'locale', 'uiConversation', 'resources', 'sidebarRight', 'sidebarRightTabs'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('waits until conversation declares the plan seat', async () => {
    const ctx = new Context()
    providePreview(ctx)
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('remote', { commands: {} })
    ctx.provide('remote.commands', {})
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.input.plan')).toHaveLength(0)
    ctx.slots.register({
      name: 'root', children: { 'conversation.input.plan': { kind: 'single', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(ctx.slots.entries('conversation.input.plan')).toHaveLength(1)
  })

  it('registers the chip, executes /plan off, and unregisters on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('conversation.input.plan')[0]!
    expect(entry.component).toBe(PlanChip)
    const injected = (entry.inject as unknown as (id: SessionId) => PlanChipInjected)(SID)

    await expect(injected.exitPlanMode()).resolves.toBeNull()
    expect(b.execute).toHaveBeenLastCalledWith(SID, '/plan off', [])

    // Business failure folds to the composer-visible line: the generated method
    // reports the RPC failure in its error branch.
    b.execute.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('session/not-found', 'gone', { sessionId: SID }),
    } as never)
    await expect(injected.exitPlanMode()).resolves.toBe('gone (session/not-found)')

    // Unmatched admission (plan-mode not composed host-side) is also a failure line.
    b.execute.mockResolvedValueOnce({ ok: true, value: undefined } as never)
    await expect(injected.exitPlanMode()).resolves.toBe('unknown command: /plan off')

    expect(b.events.entries().map(entry => entry.kind)).toEqual(['submitted-plan'])
    await fiber.dispose()
    expect(b.events.entries()).toEqual([])
    expect(b.removeResources).toHaveBeenCalledOnce()
    expect(b.removeType).toHaveBeenCalledOnce()
    expect(b.slots.entries('conversation.input.plan')).toHaveLength(0)
  })
})
