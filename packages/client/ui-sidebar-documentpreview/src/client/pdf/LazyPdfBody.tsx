/** Load the PDF renderer only after a PDF body is mounted. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { PdfBodyProps } from './pdf.tsx'

const LoadedPdfBody = lazy(async () => ({ default: (await import('./pdf.tsx')).PdfBody }))

/**
 * Suspend while the package-local PDF chunk arrives.
 * @param props - PDF body props supplied by the document slot.
 * @returns the deferred PDF renderer.
 */
export function LazyPdfBody(props: PdfBodyProps): ReactNode {
  return <Suspense fallback={null}><LoadedPdfBody {...props} /></Suspense>
}
