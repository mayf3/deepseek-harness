/** Read-only diagram preview with source fallback and per-source async ownership. */

import { useEffect, useState } from 'react'
import { renderMermaid } from './mermaid.ts'
import css from './MermaidPreview.module.css'

/** Localized preview states; the diagram source remains verbatim. */
export interface MermaidPreviewLabels {
  diagram: string
  loading: string
  error: string
}

type Result = { code: string; src: string } | { code: string; error: true }

/**
 * Display a complete Mermaid document on a light diagram canvas, or its source if rendering fails.
 * @param props - Source and complete localized labels. Changing source discards the previous result.
 * @returns A loading status, an inert SVG image, or an error with the original source.
 */
export function MermaidPreview({ code, labels }: { code: string; labels: MermaidPreviewLabels }) {
  const [result, setResult] = useState<Result | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void renderMermaid(code, controller.signal).then(
      (src) => { if (!controller.signal.aborted) setResult({ code, src }) },
      () => { if (!controller.signal.aborted) setResult({ code, error: true }) },
    )
    return () => { controller.abort() }
  }, [code])

  if (result?.code !== code) return <div className={css.status} role="status">{labels.loading}</div>
  if ('error' in result) {
    return (
      <div>
        <div className={css.status} role="status">{labels.error}</div>
        <pre><code>{code}</code></pre>
      </div>
    )
  }
  return <div className={css.canvas}><img className={css.diagram} src={result.src} alt={labels.diagram} /></div>
}
