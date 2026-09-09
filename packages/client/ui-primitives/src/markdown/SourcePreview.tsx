/** Read-only diagram preview with source fallback and per-source async ownership. */

import { useEffect, useState } from 'react'
import css from './SourcePreview.module.css'

/** Localized preview states; the diagram source remains verbatim. */
export interface PreviewLabels {
  diagram: string
  loading: string
  error: string
}

type Result = { kind: 'ok'; code: string; src: string } | { kind: 'error'; code: string }

/* v8 ignore next 3 -- closed-union backstop; only reached if a result is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable preview result: ${String(value)}`)
}

/**
 * Display a complete document or diagram, retaining the source when rendering fails.
 * @param props - Source and complete localized labels. Changing source discards the previous result.
 * @returns A loading status, an inert image or sandboxed document, or an error with the original source.
 */
export function SourcePreview({ code, labels, render, document: isDocument = false }: {
  code: string
  labels: PreviewLabels
  render: (code: string, signal: AbortSignal) => string | Promise<string>
  document?: boolean
}) {
  const [result, setResult] = useState<Result | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void (async () => await render(code, controller.signal))().then(
      (src) => { if (!controller.signal.aborted) setResult({ kind: 'ok', code, src }) },
      () => { if (!controller.signal.aborted) setResult({ kind: 'error', code }) },
    )
    return () => { controller.abort() }
  }, [code, render])

  if (result?.code !== code) return <div className={css.status} role="status">{labels.loading}</div>
  switch (result.kind) {
    case 'ok':
      if (isDocument) return <iframe className={css.frame} title={labels.diagram} sandbox="" referrerPolicy="no-referrer" srcDoc={result.src} />
      return <div className={css.canvas}><img className={css.diagram} src={result.src} alt={labels.diagram} /></div>
    case 'error':
      return (
        <div>
          <div className={css.status} role="status">{labels.error}</div>
          <pre><code>{code}</code></pre>
        </div>
      )
    /* v8 ignore next -- closed-union backstop; only reached if a result is forged */
    default: return assertNever(result)
  }
}
