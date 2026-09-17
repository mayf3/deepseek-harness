import { describe, expect, it, vi } from 'vitest'
import { IframeImpl } from '../src/client/browser/BrowserFrame.ts'

describe('IframeImpl', () => {
  it('owns transient sandbox mode and prepared document state', () => {
    const changed = vi.fn<(sandboxed: boolean) => void>()
    const loaded = vi.fn<(revision: number) => void>()
    const frame = new IframeImpl(changed, loaded)
    const listener = vi.fn()
    const unsubscribe = frame.subscribe(listener)

    frame.toggleSandbox()
    expect(frame.getSnapshot().sandboxed).toBe(false)
    expect(changed).toHaveBeenCalledWith(false)

    const document = {
      target: { kind: 'https' as const, url: 'https://example.test/', title: 'example.test' },
      src: 'https://example.test/',
      revision: 4,
    }
    frame.setDocument(document)
    frame.reportLoaded(4)
    expect(loaded).toHaveBeenCalledWith(4)
    expect(frame.clearDocument()).toBe(document)
    expect(frame.clearDocument()).toBeUndefined()
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })
})
