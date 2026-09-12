import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '../src/index.ts'
import { afterEach, expect, it, vi } from 'vitest'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

it('awaits catalog preparation before collecting and ordering first-request schemas', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, { toolOrder: ['late', '<unlisted-tools>'] })
  const entered = Promise.withResolvers<undefined>()
  const ready = Promise.withResolvers<undefined>()
  const collected = vi.fn(() => ({ schemas: [{ name: 'existing', description: '', parameters: {} }] }))
  ctx.systemPrompt.tools(collected)
  const prepare = ctx.on('system-prompt/prepare', async () => {
    entered.resolve(undefined)
    await ready.promise
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'late', description: '', parameters: {} }] }))
  })
  const assembling = ctx.systemPrompt.assemble()
  await entered.promise
  expect(collected).not.toHaveBeenCalled()
  ready.resolve(undefined)
  expect((await assembling).tools.map(tool => tool.name)).toEqual(['late', 'existing'])
  prepare()
  expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual(['late', 'existing'])
})

it('filters preparation by scope and unregisters it with its owner', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  const a = {}
  const b = {}
  const scoped = createScope(ctx, a)
  const prepare = vi.fn(async () => {})
  scoped.ctx.on('system-prompt/prepare', prepare)
  await ctx.systemPrompt.assemble({ scope: b })
  expect(prepare).not.toHaveBeenCalled()
  await ctx.systemPrompt.assemble({ scope: a })
  expect(prepare).toHaveBeenCalledOnce()
  await scoped.dispose()
  await ctx.systemPrompt.assemble({ scope: a })
  expect(prepare).toHaveBeenCalledOnce()
})

it('rejects failed or cancelled preparation before reading any provider', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  const collected = vi.fn(() => ({ schemas: [] }))
  ctx.systemPrompt.tools(collected)
  const failed = ctx.on('system-prompt/prepare', async () => { throw new Error('catalog unavailable') })
  await expect(ctx.systemPrompt.assemble()).rejects.toThrow('catalog unavailable')
  failed()
  const controller = new AbortController()
  ctx.on('system-prompt/prepare', async () => { controller.abort(new Error('cancel preparation')) })
  await expect(ctx.systemPrompt.assemble({ signal: controller.signal })).rejects.toThrow('cancel preparation')
  await expect(ctx.systemPrompt.assemble({ signal: controller.signal })).rejects.toThrow('cancel preparation')
  expect(collected).not.toHaveBeenCalled()
})
