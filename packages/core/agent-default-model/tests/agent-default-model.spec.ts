/** Default model references remain live without a settings service. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import DefaultModel from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it('reads complete selections from volatile config and clears omitted reasoning effort', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  const consumer = ctx.agentDefaultModel
  await live.update({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  expect(consumer.currentSelection()).toEqual({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  await live.replace({ provider: 'p', model: 'm' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
  await consumer.saveSelection({ provider: 'unsaved', model: 'unsaved' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
})

it('persists complete selections through its owning profile entry', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', reasoningEffort: ReasoningEffortId('high') })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next', reasoningEffort: 'high' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
  const standalone = new Context()
  onTestFinished(() => standalone.fiber.dispose())
  await standalone.plugin(DefaultModel, { provider: 'test', model: 'original' })
  await standalone.agentDefaultModel.saveSelection({ provider: 'test', model: 'ignored' })
  expect(standalone.agentDefaultModel.currentSelection().model).toBe('original')
})

it('initializes once and retains explicit profile choices after restart', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx, start } = await configurationFixture({ hmr: false })
  const defaults = ctx.agentDefaultModel
  await Promise.all([
    defaults.initializeSelection({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    defaults.initializeSelection({ provider: 'third-party', model: 'other' }),
  ])
  expect(defaults.currentSelection()).toEqual({ provider: 'deepseek-account', model: 'deepseek-flash' })
  await defaults.saveSelection({ provider: 'third-party', model: 'chosen' })
  const restarted = await start()
  await restarted.agentDefaultModel.initializeSelection({ provider: 'deepseek-account', model: 'deepseek-flash' })
  expect(restarted.agentDefaultModel.currentSelection()).toEqual({ provider: 'third-party', model: 'chosen' })
})

it('allows initialization after a refused write and retains a model-only override', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { vi } = await import('vitest')
  const { ctx, start } = await configurationFixture({ hmr: false })
  const edit = vi.spyOn(ctx.configEditor, 'edit').mockRejectedValueOnce(new Error('write failed'))
  onTestFinished(() => { edit.mockRestore() })
  await expect(ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'refused' })).rejects.toThrow('write failed')
  await ctx.agentDefaultModel.initializeSelection({ provider: 'test', model: 'initialized' })
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('initialized')
  const restarted = await start()
  const rows = restarted.configEditor.configuration().map(row => ({ ...row, override: { model: 'initialized' } }))
  const source = vi.spyOn(restarted.configEditor, 'configuration').mockReturnValue(rows)
  onTestFinished(() => { source.mockRestore() })
  await restarted.agentDefaultModel.initializeSelection({ provider: 'test', model: 'ignored' })
  expect(restarted.agentDefaultModel.currentSelection().model).toBe('initialized')
})
