// @vitest-environment jsdom
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientModuleHandoffQueue, ClientPluginHandoff, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppWebEntry } from '../src/boot.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const win = globalThis as DshWindow
const moduleFace = modulesClient as unknown as Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
  delete win.__DSH_BOOT__
  delete win.__DSH_MODULES__
  delete win.__ModuleLoader__
  document.body.innerHTML = ''
})

function installQueue(factory: ClientPluginHandoff['factory']): void {
  const handoffs: ClientPluginHandoff[] = [{ id: MODULES_ID, factory }]
  const queue: ClientModuleHandoffQueue = {
    mode: 'queue',
    handoffs,
    load: (handoff) => { handoffs.push(handoff) },
  }
  win.__ModuleLoader__ = queue
}

async function expectBootFailure(setup: () => void, message: string): Promise<void> {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const container = document.createElement('div')
  document.body.append(container)
  setup()
  const entry = new AppWebEntry(container)
  await entry.run()
  expect(container.textContent).toContain(message)
  expect(error).toHaveBeenCalledOnce()
  await entry.dispose()
}

describe('bootstrap failure rendering', () => {
  it('renders a missing bootstrap queue', async () => {
    await expectBootFailure(
      () => { delete win.__ModuleLoader__ },
      'window.__ModuleLoader__ bootstrap queue is missing',
    )
  })

  it('renders an already-live bootstrap target', async () => {
    await expectBootFailure(
      () => { win.__ModuleLoader__ = { mode: 'live', load: () => {} } },
      'window.__ModuleLoader__ bootstrap queue is missing',
    )
  })

  it('renders a missing modules handoff', async () => {
    await expectBootFailure(() => {
      installQueue(() => moduleFace)
      const queue = win.__ModuleLoader__ as ClientModuleHandoffQueue
      queue.handoffs.splice(0)
    }, `HTML did not preload ${MODULES_ID}/client.js`)
  })

  it('renders a bootstrap runtime external', async () => {
    await expectBootFailure(() => {
      installQueue((require) => {
        require('react')
        return moduleFace
      })
    }, `${MODULES_ID}/client.js requested external "react"`)
  })

  it.each(['ClientModuleSystem', 'parseBootManifest', 'apply'] as const)(
    'renders a modules handoff missing %s',
    async (missing) => {
      await expectBootFailure(() => {
        installQueue(() => ({ ...moduleFace, [missing]: undefined }))
      }, `${MODULES_ID}/client.js did not export the bootstrap module face`)
    },
  )

  it('renders a malformed boot manifest', async () => {
    await expectBootFailure(() => {
      installQueue(() => moduleFace)
      delete win.__DSH_BOOT__
    }, 'window.__DSH_BOOT__ is missing or not an object')
  })

  it('renders a module-system construction failure', async () => {
    await expectBootFailure(() => {
      installQueue(() => moduleFace)
      const duplicate = { id: 'duplicate', url: '/duplicate/client.js', rev: '1' }
      win.__DSH_BOOT__ = { rev: 'graph', entries: [duplicate, duplicate] }
    }, 'duplicate graph entry "duplicate"')
  })
})
