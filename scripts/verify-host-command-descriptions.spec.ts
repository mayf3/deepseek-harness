import { describe, expect, it } from 'vitest'
import {
  findHostCommandRegistrations,
  hostCommandDescriptionViolations,
} from './verify-host-command-descriptions.ts'

const locales = `
  export const en = {
    'description.compact': 'Compact older conversation history',
    'description.plan': 'Enter or leave plan mode',
  }
`

const service = `
  const HOST_DESCRIPTION_KEYS = new Map<string, string>([
    ['compact', 'description.compact'],
    ['plan', 'description.plan'],
  ])
`

describe('Host command description alignment', () => {
  it('discovers direct object registrations through any commands receiver', () => {
    const registrations = findHostCommandRegistrations('packages/example/src/index.ts', `
      yield ctx.commands.register({ name: 'compact', description: 'Compact older conversation history', handler })
      commandCtx.commands.register({ name: \`plan\`, description: \`Enter or leave plan mode\`, handler })
      commandUi.register({ name: 'client-only', description: 'Client contribution' })
      ctx.commands.register(definition)
    `)
    expect(registrations).toEqual([
      {
        file: 'packages/example/src/index.ts',
        line: 2,
        name: 'compact',
        description: 'Compact older conversation history',
      },
      {
        file: 'packages/example/src/index.ts',
        line: 3,
        name: 'plan',
        description: 'Enter or leave plan mode',
      },
      { file: 'packages/example/src/index.ts', line: 5 },
    ])
  })

  it('accepts exact Host, English dictionary, and allowlist alignment', () => {
    const registrations = findHostCommandRegistrations('packages/example/src/index.ts', `
      ctx.commands.register({ name: 'compact', description: 'Compact older conversation history' })
      ctx.commands.register({ name: 'plan', description: 'Enter or leave plan mode' })
    `)
    expect(hostCommandDescriptionViolations(registrations, locales, service)).toEqual([])
  })

  it('rejects non-literals, missing allowlist entries, drift, duplicates, and stale entries', () => {
    const registrations = [
      ...findHostCommandRegistrations('packages/example/src/a.ts', `
        ctx.commands.register({ name: commandName, description: 'dynamic' })
        ctx.commands.register({ name: 'compact', description: 'Changed upstream' })
        ctx.commands.register({ name: 'compact', description: 'Changed upstream' })
      `),
    ]
    expect(hostCommandDescriptionViolations(
      registrations,
      'export const en = { \'description.compact\': \'Old copy\' }',
      'const HOST_DESCRIPTION_KEYS = new Map([[\'compact\', \'description.compact\'], [\'stale\', \'description.stale\']])',
    )).toEqual([
      'packages/example/src/a.ts:2 Host command name and description must be string literals.',
      'packages/example/src/a.ts:4 duplicates /compact, first registered at packages/example/src/a.ts:3.',
      'packages/client/ui-commands/src/client/locales.ts description.compact must equal the Host description "Changed upstream".',
      'packages/client/ui-commands/src/client/service.ts HOST_DESCRIPTION_KEYS contains stale /stale.',
    ])
  })
})
