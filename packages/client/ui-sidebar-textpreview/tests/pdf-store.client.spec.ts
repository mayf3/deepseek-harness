/** PDF view preferences survive body remounts without sharing state between tabs. */
import { describe, expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createPdfStore } from '../src/client/pdf/store.ts'

describe('PDF view store', () => {
  it('keeps page and zoom together for each tab and forgets only the closed tab', () => {
    const instance = createPdfStore().create()
    const one = 'one' as TabId
    const two = 'two' as TabId
    instance.actions.page(one, 3)
    instance.actions.zoom(one, 1.5)
    instance.actions.zoom(two, 0.75)
    expect(instance.getSnapshot().byTab).toEqual({ one: { page: 3, zoom: 1.5 }, two: { page: 1, zoom: 0.75 } })
    instance.actions.forget(one)
    expect(instance.getSnapshot().byTab).toEqual({ two: { page: 1, zoom: 0.75 } })
  })

  it('creates independent Session store instances', () => {
    const store = createPdfStore()
    const first = store.create()
    const second = store.create()
    first.actions.page('same-tab' as TabId, 2)
    expect(second.getSnapshot().byTab).toEqual({})
  })
})
