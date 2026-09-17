/** Diagram-sized code surface with retained preview rendering and toolbar state. */
import { memo, useRef, useState } from 'react'
import type { Ref } from 'react'
import clsx from 'clsx'
import { Tooltip } from '../Tooltip.tsx'
import { CopyCodeButton } from './CopyCodeButton.tsx'
import { CodeBlockSource } from './CodeBlockSource.tsx'
import { SourcePreview } from './SourcePreview.tsx'
import { PreviewPlaceholder } from './PreviewPlaceholder.tsx'
import type { PreviewRenderer, SourcePreviewLabels } from './SourcePreview.tsx'
import css from './CodeBlock.module.css'

/** Renderer accepted by the public {@link CodeBlockPreview} descriptor. */
export type CodeBlockPreviewRenderer = PreviewRenderer

/** Localized output and controls for a {@link CodeBlock} preview. */
export interface CodeBlockPreviewLabels extends SourcePreviewLabels {
  /** Control label when source is visible. */
  preview: string
  /** Control label when the preview is visible. */
  source: string
}

/** Standard source-backed content displayed by a {@link CodeBlock} preview. */
export interface CodeBlockPreview {
  /** Convert the source into an isolated image. */
  render: CodeBlockPreviewRenderer
  /** Localized failure, accessible output, and control labels. */
  labels: CodeBlockPreviewLabels
}

export interface CodeBlockProps {
  /** The source text, rendered verbatim (trailing newline trimmed for display). */
  code: string
  /** Grammar hint (markdown fence info string or a fixed caller id); unknown = plain. */
  lang?: string | undefined
  /**
   * The code is still growing. Previewable fences show a placeholder without
   * rendering or highlighting; other streaming fences highlight through
   * a per-instance {@link StreamingHighlightSession}, which re-tokenizes only
   * appended text and keeps completed line groups (and DOM) untouched. The
   * caller must keep the component instance stable across growth (a
   * stream-stable React key); an unchanged streamed fence also retains that
   * tree when it settles. Cold settled callers get shiki's HTML.
   */
  streaming?: boolean | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
  /** Ref for the stable content wrapper, for owners that use it as a scrollport. */
  contentRef?: Ref<HTMLDivElement> | undefined
  /** Initial gutter preference until the reader toggles line numbers. Defaults to false; copied source excludes numbers. */
  lineNumbers?: boolean | undefined
  /** Show the language and copy header; false when the caller supplies a toolbar. Defaults to true. */
  showHeader?: boolean | undefined
  /** Copy-button idle label; the owner passes localized copy (this package is cordis-free, so copy arrives via props). */
  copyLabel: string
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel: string
  /** Selected source-view label when no preview is available. */
  sourceLabel: string
  /** Localized tooltip and accessible name for the source line-number toggle. */
  lineNumbersLabel: string
  /** Image preview, selected initially; streaming shows a placeholder. Copy always uses source. */
  preview?: CodeBlockPreview | undefined
}

/**
 * Display source or a retained diagram with localized controls.
 * @param props - Source, presentation preferences, complete labels and optional preview renderer.
 * @returns A content-sized preview, a streaming preview placeholder, or full-width source.
 */
export const CodeBlock = memo(function CodeBlock({
  code, lang, streaming, className, lineNumbers = false, showHeader = true, copyLabel, copiedLabel, sourceLabel,
  lineNumbersLabel, preview, contentRef,
}: CodeBlockProps) {
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code
  const previewAvailable = preview !== undefined
  const pendingStream = previewAvailable && streaming === true
  const [view, setView] = useState<'source' | 'preview'>('preview')
  const [sourceVisited, setSourceVisited] = useState(false)
  const [numberedOverride, setNumberedOverride] = useState<boolean>()
  const numbered = numberedOverride ?? lineNumbers
  const [actions, setActions] = useState<HTMLSpanElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const showingPreview = previewAvailable && (pendingStream || view === 'preview')
  return (
    <div ref={rootRef} className={clsx(css.block, 'md-code-block', previewAvailable && css.previewable, numbered && css.numbered, className)}
      data-code-block-header={(showHeader && previewAvailable) || undefined}
      data-line-numbers={numbered || undefined} data-preview={showingPreview || undefined}>
      {showHeader && <div className={css.bannerWrap}>
        <div className={css.banner} data-code-block-banner>
          <div className={css.infostring}>{lang ?? ''}</div>
          <div className={css.action}>
            {!pendingStream && <>
              {previewAvailable && <span ref={setActions} className={css.previewActionSlot} hidden={!showingPreview} />}
              {!showingPreview && <Tooltip label={lineNumbersLabel} side="top" delayMs={500}>
                <button type="button" className={css.iconButton} aria-label={lineNumbersLabel} aria-pressed={numbered}
                  onClick={() => { setNumberedOverride(!numbered) }}>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
                    <path d="M2 2.5h1v4m-1 0h2M1.5 10a1.25 1.25 0 0 1 2.5 0c0 1-2.5 1.5-2.5 3H4M7 4.5h7M7 11.5h7"
                      stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </Tooltip>}
              <CopyCodeButton code={trimmed} copyLabel={copyLabel} copiedLabel={copiedLabel} />
              <div className={css.segments} data-preview-selected={showingPreview || undefined}>
                <span className={css.selection} aria-hidden="true" />
                {previewAvailable ? <>
                  <button type="button" aria-pressed={!showingPreview} onClick={() => { setSourceVisited(true); setView('source') }}>{preview.labels.source}</button>
                  <button type="button" aria-pressed={showingPreview} onClick={() => { setView('preview') }}>{preview.labels.preview}</button>
                </> : <span className={css.sourceOnly}>{sourceLabel}</span>}
              </div>
            </>}
          </div>
        </div>
      </div>}
      <div ref={contentRef} className={clsx(css.body, showingPreview && css.sourceHidden)} data-code-block-content>
        {!pendingStream && <div className={clsx(css.source, showingPreview && css.sourceHidden)}
          data-code-block-source-view={previewAvailable || undefined} aria-hidden={showingPreview || undefined}>
          {(!previewAvailable || sourceVisited) && <CodeBlockSource target={rootRef} code={code} lang={lang}
            streaming={streaming} lineNumbers={numbered} highlightImmediately={previewAvailable} />}
        </div>}
      </div>
      {previewAvailable && <div className={css.previewLayer}
        data-code-block-preview hidden={!showingPreview}>
        {pendingStream ? <PreviewPlaceholder label={preview.labels.pending} /> :
          <SourcePreview code={trimmed} labels={preview.labels} render={preview.render}
            actions={actions ?? undefined} />}
      </div>}
    </div>
  )
})
