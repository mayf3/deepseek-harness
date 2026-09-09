/** Lazy Graphviz WebAssembly layout; generated SVG is displayed only as an inert image. */

import type { instance } from '@viz-js/viz'
import { renderSvg } from './preview-document.ts'

let runtime: ReturnType<typeof instance> | undefined

/**
 * Render Graphviz DOT as a sandboxed preview document.
 * @param code - Complete Graphviz DOT source.
 * @param signal - Cancels work waiting for the runtime; synchronous layout cannot be interrupted.
 * @returns A srcdoc document. Import, layout, invalid source, and cancellation failures reject.
 */
export async function renderGraphviz(code: string, signal: AbortSignal): Promise<string> {
  runtime ??= import('@viz-js/viz').then(module => module.instance()).catch((error: unknown) => {
    runtime = undefined
    throw error
  })
  const viz = await runtime
  signal.throwIfAborted()
  return renderSvg(viz.renderString(code, { format: 'svg', engine: 'dot' }), signal)
}
