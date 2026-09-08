/** PDF page presentation; binary content and tab information come from the document owner. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { DEFAULT_PDF_VIEW, type PdfStore } from './store.ts'
import { renderPdfPage, type PdfDocument } from './document.ts'
import { openPdf } from './runtime.ts'
import { PdfWorkerFailure } from './errors.ts'
import type {} from './locales.ts'
import css from './PdfBody.module.css'

/** A record's viewing preferences survive body unmounts and leave with the tab. */
export interface PdfBodyInjected {
  /**
   * Retain viewing preferences until the tab record ends.
   * @param tabId - owning tab.
   * @param signal - tab-record lifetime, not body visibility.
   */
  readonly retainTab: (tabId: TabId, signal: AbortSignal) => void
}

/** Standard document props plus the PDF entry's locale, viewing store, and lifetime callback. */
export type PdfBodyProps = DocumentPreviewProps & PropsLocale<'sidebarPdf'> & PropsStore<PdfStore> & PdfBodyInjected

type LoadState =
  | { readonly kind: 'loaded'; readonly data: Uint8Array<ArrayBuffer>; readonly document: PdfDocument }
  | { readonly kind: 'failed'; readonly data: Uint8Array<ArrayBuffer>; readonly error: unknown }

/**
 * Present a PDF with tab-local viewing preferences and component-owned rendering resources.
 * @param props - complete bytes and framework-owned tab/store/locale seats.
 * @returns the PDF reader.
 */
export function PdfBody(props: PdfBodyProps): ReactNode {
  const { tab } = props.useTabInfo()
  const view = props.useStore(state => state.byTab[tab.id] ?? DEFAULT_PDF_VIEW)
  const data = props.content.kind === 'bytes' ? props.content.data : undefined
  const [load, setLoad] = useState<LoadState>()
  const [attempt, setAttempt] = useState(0)
  const { retainTab, actions, t } = props

  useEffect(() => { retainTab(tab.id, tab.signal) }, [retainTab, tab.id, tab.signal])
  useEffect(() => {
    if (data === undefined || tab.signal.aborted) return
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, tab.signal])
    setLoad(undefined)
    const session = openPdf(data, signal, (error) => {
      if (!signal.aborted) setLoad({ kind: 'failed', data, error })
    })
    void session.document.then(
      (document) => { if (!signal.aborted) setLoad({ kind: 'loaded', data, document }) },
      (error: unknown) => { if (!signal.aborted) setLoad({ kind: 'failed', data, error }) },
    )
    return () => {
      lifetime.abort()
      void session.dispose()
    }
  }, [data, tab.signal, attempt])

  if (data === undefined) return <p className={css.status} role="alert">{t('unsupported')}</p>
  if (load?.data !== data) return <LoadingIndicator className={css.status} label={t('loading')} />
  if (load.kind === 'failed') {
    return <div className={css.status} role="alert">
      <span>{failureText(load.error, t)}</span>
      <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
    </div>
  }
  const page = Math.min(view.page, load.document.numPages)
  const setPage = (requested: number): void => {
    if (Number.isInteger(requested)) actions.page(tab.id, Math.max(1, Math.min(load.document.numPages, requested)))
  }
  const zoom = Math.max(0.25, Math.min(4, view.zoom))
  return <section className={css.body} data-pdf-preview>
    <div className={css.toolbar} role="toolbar" aria-label={t('toolbar')}>
      <Button size="sm" variant="toolbar" disabled={page <= 1} onClick={() => { setPage(page - 1) }}>{t('previous')}</Button>
      <div className={css.pageInput}>
        <Input type="number" min={1} max={load.document.numPages} value={page}
          aria-label={t('page')} onChange={(event) => { setPage(event.currentTarget.valueAsNumber) }} />
      </div>
      <span className={css.label}>{t('pageCount', { total: load.document.numPages })}</span>
      <Button size="sm" variant="toolbar" disabled={page >= load.document.numPages} onClick={() => { setPage(page + 1) }}>{t('next')}</Button>
      <Button size="sm" variant="toolbar" disabled={zoom <= 0.25} onClick={() => { actions.zoom(tab.id, Math.max(0.25, zoom - 0.25)) }}>{t('zoomOut')}</Button>
      <Button size="sm" variant="toolbar" aria-label={t('resetZoom')} onClick={() => { actions.zoom(tab.id, 1) }}>{t('zoom', { percent: Math.round(zoom * 100) })}</Button>
      <Button size="sm" variant="toolbar" disabled={zoom >= 4} onClick={() => { actions.zoom(tab.id, Math.min(4, zoom + 0.25)) }}>{t('zoomIn')}</Button>
    </div>
    <PdfPage key={`${page}:${zoom}`} document={load.document} page={page} zoom={zoom} signal={tab.signal} t={t} />
  </section>
}

function PdfPage({ document, page, zoom, signal, t }: {
  readonly document: PdfDocument
  readonly page: number
  readonly zoom: number
  readonly signal: AbortSignal
} & PropsLocale<'sidebarPdf'>): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready'>('loading')
  const [failure, setFailure] = useState<{ readonly error: unknown }>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    // The canvas is unconditional; this effect runs after its ref is committed.
    const node = canvas.current as HTMLCanvasElement
    const lifetime = new AbortController()
    const renderSignal = AbortSignal.any([lifetime.signal, signal])
    setState('loading')
    setFailure(undefined)
    void renderPdfPage(document, page, zoom, node, renderSignal, window.devicePixelRatio).then(
      () => { if (!renderSignal.aborted) setState('ready') },
      (error: unknown) => { if (!renderSignal.aborted) setFailure({ error }) },
    )
    return () => { lifetime.abort() }
  }, [document, page, zoom, signal, attempt])
  return <div className={css.page}>
    {failure === undefined && state === 'loading' && <LoadingIndicator className={css.status} label={t('rendering')} />}
    {failure !== undefined && <div className={css.status} role="alert">
      <span>{failureText(failure.error, t)}</span>
      <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
    </div>}
    <canvas ref={canvas} className={css.canvas} role="img" aria-label={t('pageImage', { page })}
      hidden={state !== 'ready' || failure !== undefined} />
  </div>
}

function failureText(error: unknown, t: PropsLocale<'sidebarPdf'>['t']): string {
  if (error instanceof PdfWorkerFailure) return t('workerFailed')
  if (error instanceof Error && error.name === 'PasswordException') return t('password')
  return t('failed', { message: error instanceof Error ? error.message : String(error) })
}
