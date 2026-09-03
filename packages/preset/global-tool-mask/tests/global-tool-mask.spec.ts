import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import * as ToolRestrict from '@deepseek-ai/dsh-global-tool-mask'

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  for (const name of ['alpha', 'beta', 'gamma']) {
    ctx.tools.register({
      name,
      description: `fixture tool ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: () => Promise.resolve(name),
    })
  }
  return ctx
}

const visible = (ctx: Context, scope?: ScopeKey): string[] =>
  ctx.tools.schemas(scope).map(schema => schema.name).sort()

describe('the global-tool-mask row', () => {
  it('rejects an unscoped mount, which would mask every agent', async () => {
    const ctx = await harness()

    await expect(ctx.plugin(ToolRestrict, { allow: [], deny: ['alpha'] })).rejects.toThrow(/requires a scoped context/)
  })

  it('hides denied global tools from one scope only', async () => {
    const ctx = await harness()
    const key: ScopeKey = { agent: 'a1' }

    await createScope(ctx, key).ctx.plugin(ToolRestrict, { allow: [], deny: ['alpha'] })

    expect(visible(ctx, key)).toEqual(['beta', 'gamma'])
    expect(visible(ctx)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('keeps only allowed tools, intersected with a deny list', async () => {
    const ctx = await harness()
    const key: ScopeKey = { agent: 'a2' }

    await createScope(ctx, key).ctx.plugin(ToolRestrict, { allow: ['alpha', 'beta'], deny: ['beta'] })

    expect(visible(ctx, key)).toEqual(['alpha'])
  })

  it('fails loud on an empty mask and on a tool the host does not register', async () => {
    const ctx = await harness()

    await expect(createScope(ctx, { agent: 'a3' }).ctx.plugin(ToolRestrict, { allow: [], deny: [] })).rejects.toThrow(/is a no-op/)
    await expect(createScope(ctx, { agent: 'a4' }).ctx.plugin(ToolRestrict, { allow: [], deny: ['nope'] }))
      .rejects.toThrow(/unknown global tool "nope"/)
  })

  it('lifts the mask when its fiber unloads', async () => {
    const ctx = await harness()
    const key: ScopeKey = { agent: 'a5' }
    const fiber = await createScope(ctx, key).ctx.plugin(ToolRestrict, { allow: [], deny: ['alpha'] })
    expect(visible(ctx, key)).toEqual(['beta', 'gamma'])

    await fiber.dispose()

    expect(visible(ctx, key)).toEqual(['alpha', 'beta', 'gamma'])
  })
})
