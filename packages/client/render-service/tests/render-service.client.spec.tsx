// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { TestSessions, TestWorkspaces } from '@deepseek-ai/dsh-client-test-runtime'
import type { Stabilizer } from '@deepseek-ai/dsh-client-test-runtime'
import * as RenderService from '../src/client/index.ts'

const mounted: (() => void)[] = []

afterEach(() => {
  act(() => { for (const unmount of mounted.splice(0)) unmount() })
  cleanup()
  document.body.innerHTML = ''
})

const stabilize: Stabilizer = async (fn) => { await act(async () => { await fn() }) }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  ctx.provide('sessions', new TestSessions(stabilize, ctx))
  ctx.provide('workspaces', new TestWorkspaces(stabilize))
  ctx.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
  const fiber = ctx.plugin({ inject: [...RenderService.inject], apply: RenderService.apply })
  await fiber.await()
  return { ctx, slots, fiber }
}

function container(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

describe('render service plugin', () => {
  it('installs the renderer and mounts the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const shell = ctx.get('appShell')
    expect(shell).toBeDefined()
    const el = container()
    act(() => { mounted.push(shell!.mount(el)) })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
  })

  it('returns an unmount disposer', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    let unmount: () => void = () => {}
    act(() => { unmount = ctx.get('appShell')!.mount(el) })
    act(() => { unmount() })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeNull()
  })

  it('retracts the service and renderer with its fiber', async () => {
    const { ctx, slots, fiber } = await bench()
    await stabilize(() => fiber.dispose())
    expect(ctx.get('appShell')).toBeUndefined()
    expect(() => slots.renderSlot('root', {})).toThrow('not installed')
  })
})
