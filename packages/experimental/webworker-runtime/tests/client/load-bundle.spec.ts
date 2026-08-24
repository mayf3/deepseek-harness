// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerTunnel } from '../../src/client/client.ts'

type StubListener = (event: { data?: unknown }) => void

function stubWorker(): {
  worker: Worker
  sent: { t: string; id: number; url: string }[]
  deliver: (frame: unknown) => void
} {
  const listeners: StubListener[] = []
  const sent: { t: string; id: number; url: string }[] = []
  return {
    worker: {
      addEventListener: (type: string, listener: StubListener) => {
        if (type === 'message') listeners.push(listener)
      },
      postMessage: (frame: unknown) => { sent.push(frame as { t: string; id: number; url: string }) },
    } as unknown as Worker,
    sent,
    deliver: (frame) => { for (const listener of listeners) listener({ data: frame }) },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.head.innerHTML = ''
})

it('loads a combo map through the tunnel and gives the blob script a local map URL', async () => {
  const { worker, sent, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const blobs: Blob[] = []
  const revoked: string[] = []
  const NativeURL = URL
  class StubURL extends NativeURL {
    static override createObjectURL(blob: Blob): string {
      blobs.push(blob)
      return `blob:fixture-${String(blobs.length)}`
    }

    static override revokeObjectURL(url: string): void {
      revoked.push(url)
    }
  }
  vi.stubGlobal('URL', StubURL)
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    for (const node of nodes) {
      if (typeof node !== 'string') queueMicrotask(() => { node.dispatchEvent(new Event('load')) })
    }
  })

  const scriptUrl = '/plugins/??a/client.js,b/client.js&rev=abc'
  const mapUrl = '/plugins/??a/client.js.map,b/client.js.map&rev=abc'
  const loading = tunnel.loadBundle(scriptUrl)
  expect(sent[0]?.url).toBe(`http://localhost:3000${scriptUrl}`)
  deliver({
    t: 'res',
    id: 1,
    status: 200,
    headers: { 'content-type': 'text/javascript' },
    body: new TextEncoder().encode(`factory();\n//# sourceMappingURL=${mapUrl}\n`).buffer,
  })
  await vi.waitFor(() => { expect(sent).toHaveLength(2) })
  expect(sent[1]?.url).toBe(`http://localhost:3000${mapUrl}`)
  const map = '{"version":3,"sections":[]}'
  deliver({
    t: 'res',
    id: 2,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(map).buffer,
  })
  await loading

  expect(await blobs[0]?.text()).toBe(map)
  expect(await blobs[1]?.text()).toContain('//# sourceMappingURL=blob:fixture-1')
  expect(revoked).toEqual(['blob:fixture-2'])
})
