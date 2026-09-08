// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { TextPreview } from '../src/client/TextPreview.tsx'
import type { TextPreviewProps } from '../src/client/TextPreview.tsx'
import type { DocumentPreviewDefinition } from '../src/client/document/registry.ts'
import { ABSOLUTE_PATH, FILE, harness, page, settle, TAB_ID } from './fixtures.client.ts'

afterEach(cleanup)

const binary: DocumentPreviewDefinition = {
  id: 'complete-document', extensions: ['md'], title: () => 'Complete document', loading: 'bytes-complete',
}

describe('document toolbar', () => {
  it('shows the shared loading indicator until a complete read settles', async () => {
    const h = harness()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof h.bytes>>>()
    h.bytes.mockReturnValueOnce(pending.promise)
    const props: TextPreviewProps = { ...h.props(), useDocumentPreviews: selector => selector([binary]) }
    const view = render(<TextPreview {...props} />)
    expect(view.getByRole('status').hasAttribute('data-document-loading')).toBe(true)
    expect(view.getByRole('status').textContent).toBe('loading')
    await act(async () => {
      pending.resolve({ ok: true, value: { absolutePath: ABSOLUTE_PATH, version: 'v1', offset: 0, data: btoa('all'), bytes: 3, eof: true } })
      await pending.promise
    })
    expect(view.queryByRole('status')).toBeNull()
  })

  it('retries and refreshes complete content and uses the read result path before metadata arrives', async () => {
    const h = harness()
    const result = { ok: true as const, value: { absolutePath: ABSOLUTE_PATH, version: 'v1', offset: 0, data: btoa('all'), bytes: 3, eof: true } }
    const read = h.bytes.mockResolvedValueOnce({
      ok: false, error: new RemoteError('workspace-file/not-found', 'Missing file', { path: ABSOLUTE_PATH }),
    }).mockResolvedValue(result)
    h.useResource.mockReturnValue({ status: 'loading', value: undefined, failure: undefined })
    const props: TextPreviewProps = {
      ...h.props(), useDocumentPreviews: selector => selector([binary]),
    }
    const view = render(<TextPreview {...props} />)
    await settle()
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.click(view.container.querySelector('[data-textpreview-retry]')!)
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[data-textpreview-path]')?.textContent).toBe(ABSOLUTE_PATH)
    expect(view.container.querySelector('[data-textpreview-tool="wrap"]')).toBeNull()
    expect(view.container.querySelector('[data-textpreview-failed]')).toBeNull()
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="reload"]')!)
    await settle()
    expect(read).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenLastCalledWith(FILE, h.controller.signal)
    h.controller.abort()
  })

  it('keeps displayed content but does not request reads while the provider is absent', async () => {
    const h = harness({ 1: page(1, ['held'], false) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    h.useResource.mockReturnValue({ status: 'none', value: undefined, failure: undefined })
    view.rerender(<TextPreview {...h.props()} />)
    fireEvent.click(view.container.querySelector('[data-textpreview-more]')!)
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="reload"]')!)
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(view.container.textContent).toContain('held')
    h.controller.abort()
  })

  it('dismisses the implementation picker with Escape without changing the selected implementation', async () => {
    const h = harness({ 1: page(1, ['held'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    fireEvent.click(view.container.querySelector('[data-document-viewer-menu]')!)
    expect(screen.getByRole('menuitem', { name: 'viewer.text' })).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.rendererId).toBeUndefined()
    h.controller.abort()
  })
})
