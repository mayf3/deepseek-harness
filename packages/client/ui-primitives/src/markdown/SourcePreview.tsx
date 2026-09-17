/** Read-only diagram preview with image loading status and per-source async ownership. */

import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '../Tooltip.tsx'
import { IconSearchOutline16 } from '../icons/index.tsx'
import { PreviewLightbox } from './PreviewLightbox.tsx'
import { PreviewPlaceholder } from './PreviewPlaceholder.tsx'
import css from './SourcePreview.module.css'
import blockCss from './CodeBlock.module.css'
import { readPreviewTheme } from './preview-theme.ts'
import { observeViewport } from './viewport.ts'

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

type Result = {
  code: string
  render: PreviewRenderer
  palette: string
  /** Last loaded image of the same source, retained while its replacement loads or fails. */
  previous: string | undefined
} & (
  | { kind: 'ok'; src: string; loaded: boolean }
  | { kind: 'error' }
)

function loadedImage(result: Result | null): string | undefined {
  if (result === null) return undefined
  switch (result.kind) {
    case 'ok': return result.loaded ? result.src : result.previous
    case 'error': return result.previous
    /* v8 ignore next -- closed-union backstop; every declared result kind is handled above. */
    default: return assertNever(result)
  }
}

/* v8 ignore next 3 -- closed-union backstop; only reached if a result is forged. */
function assertNever(value: never): never {
  throw new Error(`unreachable preview result: ${String(value)}`)
}

/**
 * Render visible diagrams and retain their loaded images during theme refreshes.
 * @param props - Source and complete localized labels. Source, visibility and document theme changes cancel obsolete renders.
 * @returns A pending status, inert image or error, with a persistent zoom action.
 */
export const SourcePreview = memo(function SourcePreview({ code, labels, render, actions }: SourcePreviewProps) {
  const pendingId = useId()
  const target = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [expanded, setExpanded] = useState<{ code: string; render: PreviewRenderer } | null>(null)
  const close = useCallback(() => { setExpanded(null) }, [])
  const current = result?.code === code && result.render === render ? result : null
  const renderedPalette = current?.palette
  const expandedCurrent = expanded?.code === code && expanded.render === render
  const active = visible || expandedCurrent
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- React attaches this surface before effects run.
    return observeViewport(target.current!, setVisible)
  }, [])
  useEffect(() => {
    if (!active) return
    let controller: AbortController | undefined
    let palette: string | undefined
    const update = () => {
      const next = JSON.stringify(readPreviewTheme())
      if (next === palette) return
      palette = next
      controller?.abort()
      if (next === renderedPalette) return
      const current = new AbortController()
      controller = current
      void (async () => await render(code, current.signal))().then(
        (src) => {
          if (current.signal.aborted) return
          controller = undefined
          setResult((prior) => {
            const previous = prior?.code === code && prior.render === render ? loadedImage(prior) : undefined
            return { kind: 'ok', code, render, palette: next, src, loaded: src === previous, previous: src === previous ? undefined : previous }
          })
        },
        () => {
          if (current.signal.aborted) return
          controller = undefined
          setResult(prior => ({ kind: 'error', code, render, palette: next,
            previous: prior?.code === code && prior.render === render ? loadedImage(prior) : undefined }))
        },
      )
    }
    // Isolated images cannot inherit the host's CSS variables.
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme'] })
    update()
    return () => { observer.disconnect(); controller?.abort() }
  }, [active, code, render, renderedPalette])

  const displayed = loadedImage(current)
  const ready = displayed !== undefined
  const pending = !ready && current?.kind !== 'error'
  const markLoaded = () => {
    if (current?.kind !== 'ok' || current.loaded) return
    setResult(prior => prior === current ? { ...current, loaded: true, previous: undefined } : prior)
  }
  return <div ref={target} className={css.root}>
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
    {pending && <PreviewPlaceholder label={labels.pending} />}
    {current?.kind === 'error' && <div className={css.failure}>
      <div className={css.status} role="status">{labels.error}</div>
    </div>}
    <div className={css.canvas} hidden={!ready}>
      {current?.previous !== undefined &&
        <img key={current.previous} className={css.diagram} src={current.previous} alt={labels.diagram} />}
      {current?.kind === 'ok' && <img key={current.src} className={css.diagram} src={current.src} alt={labels.diagram}
        hidden={!current.loaded}
        ref={(image) => {
          if (image !== null && image.complete && image.naturalWidth > 0) markLoaded()
        }}
        onLoad={markLoaded} onError={() => {
          setResult(prior => prior === current ? { kind: 'error', code, render, palette: current.palette,
            previous: current.previous } : prior)
        }} />}
    </div>
    {ready && expandedCurrent && <PreviewLightbox
      src={displayed} alt={labels.diagram} closeLabel={labels.close} interactionLabel={labels.interaction} onClose={close}
    />}
  </div>
})
