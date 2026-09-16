// @vitest-environment jsdom
/** Catalog reads preserve draft ownership and discard responses for a previous provider. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelListEditor } from '../src/client/ModelListEditor.tsx'
import type { ModelDiscoveryOutcome, ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function operations(discoverModels: ModelsOperations['discoverModels']): ModelsOperations {
  return {
    discoverModels,
    describeCredential: vi.fn(),
    storeCredential: vi.fn(),
    removeCredential: vi.fn(),
    writeSettings: vi.fn(),
  }
}

it('ignores a late catalog response after the provider changes', async () => {
  const oldCatalog = Promise.withResolvers<ModelDiscoveryOutcome>()
  const newCatalog = Promise.withResolvers<ModelDiscoveryOutcome>()
  const actions = operations(vi.fn()
    .mockReturnValueOnce(oldCatalog.promise)
    .mockReturnValueOnce(newCatalog.promise))
  const onChange = vi.fn()
  const props = {
    models: [{ id: 'm' }], onChange, operations: actions,
    disabled: false, t: (key: keyof typeof en) => en[key],
  }
  const { rerender } = render(<ModelListEditor {...props} catalogProvider="old" probe={{ settingsNs: 'llm-pi-ai', provider: 'old' }} />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).disabled).toBe(true)
  rerender(<ModelListEditor {...props} catalogProvider="new" probe={{ settingsNs: 'llm-pi-ai', provider: 'new' }} />)
  await act(async () => { newCatalog.resolve({ kind: 'found', models: [{ id: 'm', inputModalities: ['text', 'image'] }] }) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)
  await act(async () => { oldCatalog.resolve({ kind: 'found', models: [{ id: 'm', inputModalities: ['text'] }] }) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
})

it('uses provider input defaults for a model absent from the installed catalog', async () => {
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'custom' }]} onChange={onChange} defaultInput={['image']} catalogProvider="openai"
    probe={{ settingsNs: 'llm-pi-ai', provider: 'openai' }} disabled={false} t={key => en[key]}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const text = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputText })
  await waitFor(() => { expect(text.disabled).toBe(false) })
  expect(text.checked).toBe(false)
  fireEvent.click(text)
  expect(onChange).toHaveBeenCalledWith([{ id: 'custom', input: ['text', 'image'] }])
})
