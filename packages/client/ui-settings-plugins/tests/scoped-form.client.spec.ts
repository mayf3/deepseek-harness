/**
 * The per-scope forms behind one card: drafts stay with the scope they were
 * typed under, actions route to the selected scope, and inheritance is read
 * off the global form.
 */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { numberField } from '../src/client/card-form.ts'
import { ScopeSelection, ScopedCardForms } from '../src/client/scoped-form.ts'

interface Shell {
  timeoutMs?: number
}

function ready(host: StubSettingsScope<Shell>, scope: string | undefined, fields: {
  value: Shell
  user: Partial<Shell>
  inherited?: Shell
}) {
  host.publish({
    status: 'ready', writable: true, scope, registered: true, revision: 1,
    value: fields.value, base: { timeoutMs: 60000 }, user: fields.user,
    ...fields.inherited === undefined ? {} : { inherited: fields.inherited },
  })
}

function bench() {
  const hosts = new Map<string, StubSettingsScope<Shell>>()
  const bindScope = vi.fn((scope: string | undefined) => {
    const host = stubSettingsScope<Shell>()
    hosts.set(scope ?? '', host)
    return host.scope
  })
  const selection = new ScopeSelection()
  const forms = new ScopedCardForms(selection, bindScope, [numberField('timeoutMs')])
  return { hosts, bindScope, selection, forms, host: (scope?: string) => hosts.get(scope ?? '')! }
}

describe('ScopeSelection', () => {
  it('publishes a change of scope once per distinct value', () => {
    const selection = new ScopeSelection()
    const listener = vi.fn()
    selection.subscribe(listener)
    selection.select('preset/a')
    selection.select('preset/a')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(selection.current()).toBe('preset/a')
    expect(selection.getSnapshot()).toEqual({ scope: 'preset/a' })
    selection.select(undefined)
    expect(selection.current()).toBeUndefined()
  })
})

describe('ScopedCardForms', () => {
  it('binds the global form at once and a named scope on first selection, then keeps both', () => {
    const { bindScope, selection, forms } = bench()
    expect(bindScope.mock.calls).toEqual([[undefined]])
    selection.select('preset/a')
    expect(bindScope.mock.calls).toEqual([[undefined], ['preset/a']])
    selection.select(undefined)
    selection.select('preset/a')
    expect(bindScope).toHaveBeenCalledTimes(2)
    expect(forms.scopeId()).toBe('preset/a')
  })

  it('presents the selected scope\'s form and keeps each scope\'s drafts', () => {
    const { selection, forms, host } = bench()
    ready(host(), undefined, { value: { timeoutMs: 60000 }, user: {} })
    const store = forms.bind(() => ({ ...forms.shell(), timeoutMs: forms.field('timeoutMs') }))
    forms.actions().edit('timeoutMs', '1000')
    expect(store.getSnapshot()).toMatchObject({ scope: undefined, dirty: true, timeoutMs: { text: '1000' } })

    selection.select('preset/a')
    ready(host('preset/a'), 'preset/a', {
      value: { timeoutMs: 9000 }, user: {}, inherited: { timeoutMs: 9000 },
    })
    expect(store.getSnapshot()).toMatchObject({
      scope: 'preset/a', dirty: false, timeoutMs: { text: '9000', overridden: false, inherited: false },
    })
    forms.actions().edit('timeoutMs', '2000')
    expect(store.getSnapshot()).toMatchObject({ dirty: true, timeoutMs: { text: '2000', overridden: true } })

    selection.select(undefined)
    expect(store.getSnapshot()).toMatchObject({ scope: undefined, dirty: true, timeoutMs: { text: '1000' } })
    // A publication from the unselected scope does not re-project the selected one.
    const listener = vi.fn()
    forms.subscribe(listener)
    ready(host('preset/a'), 'preset/a', { value: { timeoutMs: 9000 }, user: {}, inherited: { timeoutMs: 9000 } })
    expect(listener).not.toHaveBeenCalled()
    ready(host(), undefined, { value: { timeoutMs: 60000 }, user: {} })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('marks a named scope\'s field inherited when the global user layer carries it', async () => {
    const { selection, forms, host } = bench()
    ready(host(), undefined, { value: { timeoutMs: 12000 }, user: { timeoutMs: 12000 } })
    selection.select('preset/a')
    ready(host('preset/a'), 'preset/a', {
      value: { timeoutMs: 12000 }, user: {}, inherited: { timeoutMs: 12000 },
    })
    expect(forms.field('timeoutMs')).toEqual({ text: '12000', overridden: false, inherited: true, invalid: false })
    expect(forms.scope()).toBe(host('preset/a').scope)

    // Once the scope overrides the field, inheritance no longer applies.
    host('preset/a').set.mockImplementation((field: string, value: unknown) => {
      ready(host('preset/a'), 'preset/a', {
        value: { [field]: value }, user: { [field]: value }, inherited: { timeoutMs: 12000 },
      })
    })
    forms.actions().edit('timeoutMs', '3000')
    await forms.save()
    expect(forms.field('timeoutMs')).toMatchObject({ text: '3000', overridden: true, inherited: false })
    // Reset stages the inherited value, and discard drops it.
    forms.actions().resetField('timeoutMs')
    expect(forms.field('timeoutMs')).toMatchObject({ text: '12000', overridden: false, inherited: true })
    forms.actions().discard()
    expect(forms.field('timeoutMs')).toMatchObject({ text: '3000', overridden: true })
    // Under the global instance nothing is ever inherited.
    selection.select(undefined)
    expect(forms.field('timeoutMs')).toMatchObject({ overridden: true, inherited: false })
  })
})
