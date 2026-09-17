/** Lazy Graphviz WebAssembly layout; generated SVG is displayed only as an inert image. */

import type { instance } from '@viz-js/viz'
import { renderSvg } from './svg.ts'
import { readPreviewTheme } from './preview-theme.ts'

let runtime: ReturnType<typeof instance> | undefined

/**
 * Render Graphviz DOT with document-theme defaults; authored attributes override those defaults.
 * @param code - Complete Graphviz DOT source.
 * @param signal - Cancels work waiting for the runtime; synchronous layout cannot be interrupted.
 * @returns An SVG image data URL. Import, layout, invalid source, and cancellation failures reject.
 */
export async function renderGraphviz(code: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  runtime ??= import('@viz-js/viz').then(module => module.instance()).catch((error: unknown) => {
    runtime = undefined
    throw error
  })
  const viz = await runtime
  signal.throwIfAborted()
  const palette = readPreviewTheme()
  const color = (value: string): string => value.replace(
    /^rgb\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)\s*\)$/,
    (_match, r: string, g: string, b: string) => `#${[r, g, b].map(channel => Number(channel).toString(16).padStart(2, '0')).join('')}`,
  )
  return renderSvg(viz.renderString(code, {
    engine: 'dot', format: 'svg',
    graphAttributes: { bgcolor: 'transparent', fontcolor: color(palette.text) },
    nodeAttributes: {
      color: color(palette.border), fontcolor: color(palette.text), fillcolor: color(palette.surface), style: 'filled',
    },
    edgeAttributes: { color: color(palette.line), fontcolor: color(palette.text) },
  }), signal)
}
