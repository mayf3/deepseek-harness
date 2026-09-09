/** Mermaid image preview using the shared asynchronous source renderer. */

import { renderMermaid } from './mermaid.ts'
import { SourcePreview } from './SourcePreview.tsx'
import type { PreviewLabels } from './SourcePreview.tsx'

/** Localized Mermaid preview states; source remains verbatim. */
export type MermaidPreviewLabels = PreviewLabels

/**
 * Display a complete Mermaid document as an inert SVG image.
 * @param props - Source and complete localized labels.
 * @returns A loading status, diagram image, or error with the original source.
 */
export function MermaidPreview({ code, labels }: { code: string; labels: MermaidPreviewLabels }) {
  return <SourcePreview code={code} labels={labels} render={renderMermaid} />
}
