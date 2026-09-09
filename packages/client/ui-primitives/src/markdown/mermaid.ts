/** Lazy Mermaid runtime; each render owns and removes its temporary measurement DOM. */

import type { Mermaid } from 'mermaid'
import clsx from 'clsx'
import css from './SourcePreview.module.css'

let runtime: Promise<Mermaid> | undefined
let nextDiagramId = 0

function loadMermaid(): Promise<Mermaid> {
  runtime ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'neutral',
      htmlLabels: false,
      secure: [
        'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
        'suppressErrorRendering', 'theme', 'themeVariables', 'themeCSS', 'htmlLabels', 'flowchart',
      ],
    })
    return mermaid
  }).catch((error: unknown) => {
    runtime = undefined
    throw error
  })
  return runtime
}

/**
 * Render untrusted diagram source as an SVG image URL, without installing SVG or link handlers in the UI.
 * @param code - Complete Mermaid source.
 * @param signal - Cancels work waiting for the runtime; an active Mermaid render finishes before cleanup.
 * @returns An SVG data URL. Import, parse, rendering, and cancellation failures reject.
 */
export async function renderMermaid(code: string, signal: AbortSignal): Promise<string> {
  const mermaid = await loadMermaid()
  signal.throwIfAborted()
  const stage = document.createElement('div')
  stage.className = clsx(css.staging)
  stage.setAttribute('aria-hidden', 'true')
  document.body.append(stage)
  try {
    // Mermaid's public render API serializes diagram work; the lower-level mermaidAPI does not.
    const { svg } = await mermaid.render(`dsh-mermaid-${nextDiagramId++}`, code, stage)
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
    const viewBox = root.getAttribute('viewBox')
    if (viewBox !== null) {
      // An SVG image needs intrinsic dimensions; Mermaid's percentage width is for inline SVG.
      const [, , width, height] = viewBox.split(/\s+/) as [string, string, string, string]
      root.setAttribute('width', width)
      root.setAttribute('height', height)
    }
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`
  } finally {
    stage.remove()
  }
}
