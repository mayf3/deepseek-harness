/** Memoized source rendering, including retained incremental highlight groups. */
import { Fragment, memo, useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { StreamingHighlightSession, isGrammarLoaded, highlightToHtml, subscribeGrammarLoaded } from './highlight.ts'
import type { HighlightSpan, StreamingHighlightFrame } from './highlight.ts'
import type { CodeBlockProps } from './CodeBlock.tsx'
import { useViewportHighlighting } from './useViewportHighlighting.ts'
import css from './CodeBlock.module.css'

/**
 * The `pre` attributes shiki's HTML arm emits for the css-variables theme,
 * mirrored so the streaming arm's tree is interchangeable with the settled
 * swap (`tests/streaming-code-block.client.spec.tsx` pins the two arms'
 * parity).
 */
const SHIKI_PRE_PROPS = {
  className: 'shiki css-variables',
  style: { backgroundColor: 'var(--shiki-background)', color: 'var(--shiki-foreground)' },
  tabIndex: 0,
} as const

/** Completed-line group size; React reconciles groups while the DOM remains line-for-line identical. */
const STREAMING_LINE_GROUP_SIZE = 32

function renderLine(line: readonly HighlightSpan[], index: number): ReactNode {
  return (
    <Fragment key={index}>
      {index > 0 && '\n'}
      <span className="line">
        {line.map((span, spanIndex) => <span key={spanIndex} style={span.style}>{span.text}</span>)}
      </span>
    </Fragment>
  )
}

/**
 * Highlight one source surface independently of toolbar and preview state.
 * @param props - Authored source, grammar hint, streaming state and gutter choice.
 * @returns Source DOM retained across view changes and repeated rendering of the same highlight frame.
 */
export const CodeBlockSource = memo(function CodeBlockSource({ code, lang, streaming, lineNumbers, target, highlightImmediately }:
  Pick<CodeBlockProps, 'code' | 'lang' | 'streaming' | 'lineNumbers'> & {
    target: RefObject<HTMLDivElement>
    highlightImmediately: boolean
  }) {
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code
  const sourceLines = lineNumbers ? trimmed.split('\n') : undefined
  const highlighting = useViewportHighlighting(target, lang, highlightImmediately)
  const snapshot = useCallback(() => isGrammarLoaded(lang), [lang])
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, snapshot, snapshot)
  // Streaming state lives in refs mutated inside the memo (the MarkdownText
  // streaming-cache pattern): the session's caches carry across chunks only
  // because the owner keys this instance stably while the fence grows.
  const sessionRef = useRef<StreamingHighlightSession | null>(null)
  const lineCacheRef = useRef<{
    code: string
    lang: string | undefined
    generation: number
    frame: StreamingHighlightFrame
    groups: ReactNode[]
    pending: ReactNode[]
    nextLine: number
    body: ReactNode
  } | null>(null)
  const settledRef = useRef(false)
  const streamedBody = useMemo(() => {
    if (!highlighting) {
      sessionRef.current = null
      lineCacheRef.current = null
      settledRef.current = false
      return undefined
    }
    if (streaming !== true) {
      const previous = lineCacheRef.current
      if (previous !== null && previous.code === trimmed && previous.lang === lang) {
        settledRef.current = true
        return previous.body
      }
      sessionRef.current = null
      lineCacheRef.current = null
      settledRef.current = true
      return undefined
    }
    if (settledRef.current) {
      sessionRef.current = null
      lineCacheRef.current = null
      settledRef.current = false
    }
    sessionRef.current ??= new StreamingHighlightSession()
    const frame = sessionRef.current.updateFrame(trimmed, lang)
    if (frame === undefined) {
      lineCacheRef.current = null
      return undefined
    }
    const previous = lineCacheRef.current
    if (previous?.frame === frame && previous.code === trimmed && previous.lang === lang) {
      return previous.body
    }
    const sameGeneration = previous?.generation === frame.generation
    const groups = sameGeneration ? [...previous.groups] : []
    let pending = sameGeneration ? [...previous.pending] : []
    let nextLine = sameGeneration ? previous.nextLine : 0
    for (const line of frame.appended) {
      pending.push(renderLine(line, nextLine))
      nextLine += 1
      if (pending.length !== STREAMING_LINE_GROUP_SIZE) continue
      const start = nextLine - pending.length
      groups.push(<Fragment key={start}>{pending}</Fragment>)
      pending = []
    }
    const tail = frame.tail.map((line, index) => renderLine(line, nextLine + index))
    const tailGroup = <Fragment key={nextLine - pending.length}>{[...pending, ...tail]}</Fragment>
    const body = <pre {...SHIKI_PRE_PROPS} data-code-block-source><code>{groups}{tailGroup}</code></pre>
    lineCacheRef.current = {
      code: trimmed, lang, generation: frame.generation, frame, groups, pending, nextLine, body,
    }
    return body
  }, [streaming, highlighting, trimmed, lang, loaded])
  const html = useMemo(
    () => (highlighting && streaming !== true && streamedBody === undefined
      ? highlightToHtml(trimmed, lang)
      : undefined),
    [streaming, highlighting, streamedBody, trimmed, lang, loaded],
  )
  // shiki's HTML output is a static span tree it generated from `code` (no
  // user HTML passes through), the sanctioned innerHTML consumption path per
  // shiki's own docs.
  const body = streamedBody !== undefined
    ? streamedBody
    : html === undefined
      ? (
        <pre className={css.plain} data-code-block-source><code>{sourceLines === undefined ? trimmed : sourceLines.map((line, index) => (
          <Fragment key={index}>{index > 0 && '\n'}<span className="line">{line}</span></Fragment>
        ))}</code></pre>
      )
      : (
        <div data-code-block-source dangerouslySetInnerHTML={{ __html: html }} />
      )

  return <div style={sourceLines === undefined ? undefined : {
    '--dsl-code-block-line-number-width': `${Math.max(2, String(sourceLines.length).length)}ch`,
  } as CSSProperties}>{body}</div>
})
