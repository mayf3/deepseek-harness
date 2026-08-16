// Multi-session inspect provider registration: per-session plugins (tool-cordis
// in the cordis preset) mount the same provider ids concurrently. Later
// registrations shadow earlier ones for queries; each disposer removes exactly
// its own entry, so sessions mount and unmount independently.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CordisInspectRegistryService } from '../src/inspect-registry.ts'
import type { HostCordisInspectProviderRegistration } from '../src/inspect-registry.ts'

/** One minimal provider; the returned marker tells which registration answered. */
function provider(id: string, marker: string): HostCordisInspectProviderRegistration {
  return {
    manifest: {
      id,
      description: `${id} (${marker})`,
      methods: [{
        name: 'ping',
        description: 'ping',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
          type: 'object',
          properties: { marker: { type: 'string' } },
          additionalProperties: false,
        },
      }],
    },
    async query(method) {
      if (method !== 'ping') throw new Error(`unknown method "${method}"`)
      return { marker }
    },
  }
}

function harness() {
  const ctx = new Context()
  const service = new CordisInspectRegistryService(ctx)
  const query = async (id: string) => {
    const result = await service.query('host', id, 'ping', undefined, {} as never, new AbortController().signal)
    return result as { marker: string }
  }
  return { service, query }
}

describe('CordisInspectRegistryService multi-session registration', () => {
  it('a second registration of the same id shadows the first for queries', async () => {
    const { service, query } = harness()
    service.register(provider('Service', 'session-a'))
    service.register(provider('Service', 'session-b'))

    expect(await query('Service')).toEqual({ marker: 'session-b' })
    expect(service.list().find(p => p.id === 'Service')?.description).toContain('session-b')
  })

  it('disposing the newest registration falls back to the earlier one', async () => {
    const { service, query } = harness()
    const disposeA = service.register(provider('Service', 'session-a'))
    const disposeB = service.register(provider('Service', 'session-b'))

    disposeB()
    expect(await query('Service')).toEqual({ marker: 'session-a' })

    disposeA()
    await expect(query('Service')).rejects.toThrow(/is not registered/)
  })

  it('disposing an older registration leaves the newer one answering', async () => {
    const { service, query } = harness()
    const disposeA = service.register(provider('Service', 'session-a'))
    service.register(provider('Service', 'session-b'))

    disposeA()
    expect(await query('Service')).toEqual({ marker: 'session-b' })
  })

  it('independent ids stay independent', async () => {
    const { service, query } = harness()
    service.register(provider('Service', 's'))
    service.register(provider('Event', 'e'))

    expect(await query('Service')).toEqual({ marker: 's' })
    expect(await query('Event')).toEqual({ marker: 'e' })
    await expect(query('Tool')).rejects.toThrow(/is not registered/)
  })
})
