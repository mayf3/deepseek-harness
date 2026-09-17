// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { highlightToHtml, StreamingHighlightSession, subscribeGrammarLoaded } from '../src/markdown/highlight.ts'
import { markdownLabels } from './labels.client.ts'

const samples = [
  {
    lang: 'dot',
    code: 'digraph G {\n  // route\n  /* multi\n     line */\n  node [shape=box];\n  A -> B [label="hello"];\n}',
    tokens: [['digraph', 'keyword'], ['// route', 'comment'], ['line */', 'comment'], ['"hello"', 'string-expression']],
  },
  {
    lang: 'svg',
    code: '<svg xmlns="http://www.w3.org/2000/svg">\n  <!-- multi\n       line -->\n  <rect width="20" fill="red"/>\n</svg>',
    tokens: [['svg', 'string-expression'], ['line -->', 'comment'], ['width', 'function'], ['"red"', 'string-expression']],
  },
  {
    lang: 'mermaid',
    code: 'flowchart LR\n  %% route\n  A["Input"] --> B["Preview"]',
    tokens: [['flowchart', 'keyword'], ['%% route', 'comment'], ['"Input"', 'string']],
  },
] as const

afterEach(cleanup)

function tokenTree(root: ParentNode) {
  return [...root.querySelectorAll('pre.shiki .line')].map(line =>
    [...line.querySelectorAll<HTMLElement>('span[style]')].map(span => [span.textContent, span.style.cssText]),
  )
}

describe('diagram source highlighting', () => {
  // Each grammar's first use is isolated from the other highlighter spec files.
  it.each(samples)('automatically highlights cold $lang source in both rendering modes', async ({ lang, code, tokens }) => {
    const ready = Promise.withResolvers<undefined>()
    const stop = subscribeGrammarLoaded(() => { ready.resolve(undefined) })
    try {
      const settled = render(<CodeBlock code={code} lang={lang.toUpperCase()} {...markdownLabels.code} />)
      const streamed = render(<CodeBlock code={code} lang={lang} streaming {...markdownLabels.code} />)
      expect(settled.container.querySelector('pre.shiki')).toBeNull()
      expect(streamed.container.querySelector('pre.shiki')).toBeNull()
      await act(async () => { await ready.promise })
      expect(settled.container.querySelector('pre.shiki')?.textContent).toBe(code)
      expect(streamed.container.querySelector('pre.shiki')?.textContent).toBe(code)
      expect(tokenTree(streamed.container)).toEqual(tokenTree(settled.container))
      const spans = [...settled.container.querySelectorAll<HTMLElement>('pre.shiki span[style]')]
      for (const [text, color] of tokens) {
        expect(spans.some(span => span.textContent?.trim() === text
          && span.style.color === `var(--shiki-token-${color})`), text).toBe(true)
      }
    } finally {
      stop()
    }
  })

  it('uses one grammar for DOT aliases and reuses XML for SVG', () => {
    const code = samples[0].code
    expect(highlightToHtml(code, 'DoT')).toBe(highlightToHtml(code, 'GrApHvIz'))
    expect(highlightToHtml(samples[1].code, 'SVG')).toBe(highlightToHtml(samples[1].code, 'xml'))
    const session = new StreamingHighlightSession()
    const first = session.update(code, 'dot')
    expect(session.update(code, 'GRAPHVIZ')?.[0]).toBe(first?.[0])
  })

  it.each(samples)('matches full $lang highlighting at every appended character and retains settled DOM', ({ lang, code }) => {
    const session = new StreamingHighlightSession()
    for (let end = 1; end <= code.length; end += 1) {
      const prefix = code.slice(0, end)
      expect(session.update(prefix, lang)).toEqual(new StreamingHighlightSession().update(prefix, lang))
    }
    const firstChunk = code.slice(0, code.indexOf('\n') + 1)
    const view = render(<CodeBlock code={firstChunk} lang={lang} streaming {...markdownLabels.code} />)
    const firstLine = view.container.querySelector('pre.shiki .line')
    expect(firstLine).not.toBeNull()
    view.rerender(<CodeBlock code={code} lang={lang} streaming {...markdownLabels.code} />)
    expect(view.container.querySelector('pre.shiki .line')).toBe(firstLine)
    const pre = view.container.querySelector('pre.shiki')
    const streamed = tokenTree(view.container)
    const settled = render(<CodeBlock code={code} lang={lang} {...markdownLabels.code} />)
    expect(streamed).toEqual(tokenTree(settled.container))
    view.rerender(<CodeBlock code={code} lang={lang} {...markdownLabels.code} />)
    expect(view.container.querySelector('pre.shiki')).toBe(pre)
    expect(tokenTree(view.container)).toEqual(streamed)
  })
})
