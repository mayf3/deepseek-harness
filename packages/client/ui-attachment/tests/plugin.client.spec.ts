import { describe, expect, it, vi } from 'vitest'
import { apply as applyHost } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { ComposerAttachments } from '../src/client/ComposerAttachments.tsx'
import { MessageImages } from '../src/client/MessageImages.tsx'

describe('attachment plugin', () => {
  it('keeps the host half empty', () => {
    expect(() => { applyHost() }).not.toThrow()
  })

  it('registers the composer and historical-image slot entries', () => {
    const registered: Array<{ spec: unknown; component: unknown }> = []
    const register = vi.fn((spec: unknown, component: unknown) => {
      registered.push({ spec, component })
      return () => {}
    })
    const injectSlot = vi.fn((_name: string, setup: () => unknown) => setup())

    apply({ slots: { inject: injectSlot, register } } as never)

    expect(inject).toEqual(['slots'])
    expect(injectSlot.mock.calls.map(([name]) => name)).toEqual([
      'conversation.input.attachments',
      'conversation.message.images',
    ])
    expect(registered).toEqual([
      {
        spec: { name: 'conversation.input.attachments', locale: 'conversation' },
        component: ComposerAttachments,
      },
      {
        spec: { name: 'conversation.message.images', locale: 'conversation' },
        component: MessageImages,
      },
    ])
  })
})
