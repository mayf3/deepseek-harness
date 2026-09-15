/** Read-only diagram preview with image loading status and per-source async ownership. */

import { memo, useCallback, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '../Tooltip.tsx'
import { IconSearchOutline16 } from '../icons/index.tsx'
import { PreviewLightbox } from './PreviewLightbox.tsx'
import { PreviewPlaceholder } from './PreviewPlaceholder.tsx'
import css from './SourcePreview.module.css'
import blockCss from './CodeBlock.module.css'
import { readPreviewTheme } from './preview-theme.ts'

/** Localized preview output; the diagram source remains verbatim. */
export interface PreviewLabels {
  diagram: string
  error: string
}

/** Localized controls added by the interactive preview surface. */
export interface SourcePreviewLabels extends PreviewLabels {
  zoom: string
  pending: string
  close: string
  interaction: string
}

/**
 * Convert source into an isolated preview image URL.
 * @param code - Complete preview source.
 * @param signal - Cancels publication of obsolete work.
 * @returns The isolated image URL, synchronously or asynchronously.
 */
export type PreviewRenderer = (code: string, signal: AbortSignal) => string | Promise<string>

/** Inputs whose identity controls preview rendering and localized status copy. */
export interface SourcePreviewProps {
  code: string
  labels: SourcePreviewLabels
  render: PreviewRenderer
  /** Existing action container that receives the zoom control. */
  actions?: HTMLElement | undefined
}

type Result =
  | { kind: 'ok'; code: string; render: PreviewRenderer; src: string; loaded: boolean }
  | { kind: 'error'; code: string; render: PreviewRenderer }

/* v8 ignore next 3 -- closed-union backstop; only reached if a result is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable preview result: ${String(value)}`)
}

/**
 * Display a complete diagram after its image loads, or a localized failure status.
 * @param props - Source and complete localized labels. Source and document theme changes cancel obsolete renders.
 * @returns A pending status, inert image or error, with a persistent zoom action.
 */
export const SourcePreview = memo(function SourcePreview({ code, labels, render, actions }: SourcePreviewProps) {
  const pendingId = useId()
  const [result, setResult] = useState<Result | null>(null)
  const [expanded, setExpanded] = useState<{ code: string; render: PreviewRenderer } | null>(null)
  const close = useCallback(() => { setExpanded(null) }, [])
  useEffect(() => {
    let controller: AbortController | undefined
    let palette: string | undefined
    const update = () => {
      const next = JSON.stringify(readPreviewTheme())
      if (next === palette) return
      palette = next
      controller?.abort()
      const current = new AbortController()
      controller = current
      void (async () => await render(code, current.signal))().then(
        (src) => { if (!current.signal.aborted) setResult({ kind: 'ok', code, render, src, loaded: false }) },
        () => { if (!current.signal.aborted) setResult({ kind: 'error', code, render }) },
      )
    }
    // Isolated images cannot inherit the host's CSS variables.
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme'] })
    update()
    return () => { observer.disconnect(); controller?.abort() }
  }, [code, render])

  const current = result?.code === code && result.render === render ? result : null
  const ready = current?.kind === 'ok' && current.loaded
  const pending = current === null || (current.kind === 'ok' && !current.loaded)
  let body: ReactNode
  if (current === null) {
    body = <PreviewPlaceholder label={labels.pending} />
  } else {
    switch (current.kind) {
      case 'ok':
        body = <>
          {!current.loaded && <PreviewPlaceholder label={labels.pending} />}
          <div className={css.canvas} hidden={!current.loaded}>
            <img key={current.src} className={css.diagram} src={current.src} alt={labels.diagram}
              ref={(image) => {
                if (!current.loaded && image !== null && image.complete && image.naturalWidth > 0) {
                  setResult({ ...current, loaded: true })
                }
              }}
              onLoad={() => { setResult({ ...current, loaded: true }) }}
              onError={() => { setResult({ kind: 'error', code, render }) }} />
          </div>
        </>
        break
      case 'error':
        body = <div className={css.failure}>
          <div className={css.status} role="status">{labels.error}</div>
        </div>
        break
      /* v8 ignore next -- closed-union backstop; only reached if a result is forged */
      default: return assertNever(current)
    }
  }
  return <>
    {actions !== undefined && createPortal(
      <Tooltip label={ready ? labels.zoom : pending ? labels.pending : labels.error} side="top" delayMs={500}>
        <span className={blockCss.iconSlot}>
          <button type="button" className={blockCss.iconButton} aria-label={labels.zoom} disabled={!ready}
            aria-describedby={ready ? undefined : pendingId} onClick={() => {
              setExpanded({ code, render })
            }}><span aria-hidden="true"><IconSearchOutline16 /></span></button>
          {!ready && <span id={pendingId} hidden>{pending ? labels.pending : labels.error}</span>}
        </span>
      </Tooltip>, actions,
    )}
    {body}
    {ready && expanded?.code === code && expanded.render === render && <PreviewLightbox
      src={current.src} alt={labels.diagram} closeLabel={labels.close} interactionLabel={labels.interaction} onClose={close}
    />}
  </>
})
