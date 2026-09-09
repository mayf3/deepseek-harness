/** Lazy Mermaid runtime; each render owns and removes its temporary measurement DOM. */

import type { Mermaid, MermaidConfig } from 'mermaid'
import clsx from 'clsx'
import css from './SourcePreview.module.css'
import { readPreviewTheme } from './preview-theme.ts'

let runtime: Promise<Mermaid> | undefined
let nextDiagramId = 0
let pending: Promise<unknown> = Promise.resolve()

function loadMermaid(): Promise<Mermaid> {
  runtime ??= import('mermaid').then(({ default: mermaid }) => mermaid).catch((error: unknown) => {
    runtime = undefined
    throw error
  })
  return runtime
}

function initialize(mermaid: Mermaid, config: MermaidConfig | undefined): void {
  const palette = readPreviewTheme()
  mermaid.initialize({
    theme: 'base',
    ...config,
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    themeVariables: {
      darkMode: palette.dark,
      background: palette.background,
      primaryColor: palette.surface,
      primaryTextColor: palette.text,
      primaryBorderColor: palette.border,
      secondaryColor: palette.surface,
      tertiaryColor: palette.surface,
      lineColor: palette.line,
      textColor: palette.text,
      actorBkg: palette.surface,
      actorBorder: palette.border,
      actorTextColor: palette.text,
      actorLineColor: palette.border,
      signalColor: palette.line,
      signalTextColor: palette.text,
      labelBoxBkgColor: palette.surface,
      labelTextColor: palette.text,
      edgeLabelBackground: palette.background,
      ...config?.themeVariables as Record<string, unknown> | undefined,
    },
    htmlLabels: false,
    // Mermaid still accepts this legacy override alongside the global HTML-label setting.
    // oxlint-disable-next-line typescript/no-deprecated
    flowchart: { ...config?.flowchart, htmlLabels: false },
    secure: [
      'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
      'suppressErrorRendering', 'theme', 'themeVariables', 'themeCSS', 'htmlLabels', 'flowchart',
      ...(config?.secure ?? []),
    ],
  })
}

/**
 * Render untrusted diagram source using the document palette, without installing SVG or link handlers in the UI.
 * @param code - Complete Mermaid source.
 * @param signal - Cancels work waiting for the runtime; an active Mermaid render finishes before cleanup.
 * @param config - Native overrides of theme defaults; strict security, manual rendering, and disabled HTML labels remain fixed.
 * @returns An SVG data URL. Import, parse, rendering, and cancellation failures reject.
 */
export async function renderMermaid(code: string, signal: AbortSignal, config?: MermaidConfig): Promise<string> {
  const task = pending.then(() => renderOne(code, signal, config))
  pending = task.catch(() => { /* The caller owns rejection; subsequent diagrams still render. */ })
  return task
}

async function renderOne(code: string, signal: AbortSignal, config: MermaidConfig | undefined): Promise<string> {
  const mermaid = await loadMermaid()
  signal.throwIfAborted()
  initialize(mermaid, config)
  const stage = document.createElement('div')
  stage.className = clsx(css.staging)
  stage.setAttribute('aria-hidden', 'true')
  document.body.append(stage)
  try {
    // Initialization and rendering share the queue because Mermaid owns global configuration.
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
