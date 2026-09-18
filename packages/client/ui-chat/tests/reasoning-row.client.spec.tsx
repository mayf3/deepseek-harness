// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

describe('ReasoningRow', () => {
  it.each([
    { kind: 'text' as const, text: 'Answer' },
    { kind: 'tool-call' as const, callId: 'call-1', name: 'read', argsRaw: '{}' },
  ])('starts collapsed and preserves manual expansion when $kind arrives', (nextBlock) => {
    const reasoning = { kind: 'reasoning' as const, text: 'Inspect the session\nCheck persistence' }
    const view = render(
      <AssistantMarkdown t={t} blocks={[reasoning]} streaming renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.getByText('思考'))
    view.rerender(
      <AssistantMarkdown t={t} blocks={[reasoning, nextBlock]} streaming renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    view.rerender(
      <AssistantMarkdown t={t} blocks={[reasoning, nextBlock]} streaming={false} renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()
    fireEvent.click(view.getByText('思考'))
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('holds the first line of the current streaming paragraph, then hides settled reasoning in Compact mode', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('运行中')).toBeTruthy()
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('Inspect the session').parentElement?.getAttribute('data-streaming'))
      .toBe('true')

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('Inspect the session')).toBeTruthy()
    expect(view.queryByText('Newest reasoning tokens keep arriving')).toBeNull()

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving\n \nCompare the persisted events' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('Inspect the session')).toBeTruthy()
    expect(view.queryByText('Compare the persisted events')).toBeNull()

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving\n \nCompare the persisted events\nwithout replacing the summary\n' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('Compare the persisted events')).toBeTruthy()
    expect(view.queryByText('without replacing the summary')).toBeNull()

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving\n \nCompare the persisted events\nwithout replacing the summary\n' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByRole('button').textContent).toBe('思考')
    expect(view.queryByText('Inspect the session')).toBeNull()
    expect(view.queryByText('运行中')).toBeNull()

  })

  it.each(['\n', '\r\n'])('holds completed paragraph previews across streamed %j line endings', (newline) => {
    const renderText = (text: string) => (
      <AssistantMarkdown t={t} blocks={[{ kind: 'reasoning', text }]} streaming renderMessageImages={renderMessageImages} />
    )
    const view = render(renderText(`First paragraph${newline}${newline}Pending`))
    expect(view.getByText('First paragraph')).toBeTruthy()
    expect(view.queryByText('Pending')).toBeNull()

    view.rerender(renderText(`First paragraph${newline}${newline}Second paragraph${newline} ${newline}Third`))
    expect(view.getByText('Second paragraph')).toBeTruthy()
    expect(view.queryByText('Third')).toBeNull()

    view.rerender(renderText(`First paragraph${newline}${newline}Second paragraph${newline} ${newline}Third${newline}More tokens`))
    expect(view.getByText('Third')).toBeTruthy()
    expect(view.queryByText('More tokens')).toBeNull()
  })

  it('expands completed reasoning from the Think title', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const row = view.getByRole('button')

    fireEvent.click(view.getByText('思考'))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()

    fireEvent.click(view.getByText('思考'))
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    {
      label: 'settled',
      text: '**Comparing checkout and merge bases**\nKeep **reviewing**',
      streaming: false,
    },
    {
      label: 'streaming',
      text: 'Inspect the session\n\n**Comparing checkout and merge bases**\nKeep **reviewing**',
      streaming: true,
    },
  ])('strips double-asterisk markers from the $label summary and renders body emphasis', ({ text, streaming }) => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={streaming}
        renderMessageImages={renderMessageImages}
      />,
    )

    if (streaming) expect(view.getByText('Comparing checkout and merge bases')).toBeTruthy()
    else expect(view.getByRole('button').textContent).toBe('思考')
    expect(view.queryByText('**Comparing checkout and merge bases**')).toBeNull()

    fireEvent.click(view.getByText('思考'))
    expect(view.getByText('Comparing checkout and merge bases').tagName).toBe('STRONG')
    expect(view.container.querySelector('[class*="thinkBody"]')?.textContent).not.toContain('**')
  })

  it('renders compact headings only while expanded', () => {
    const text = Array.from({ length: 6 }, (_, index) => `${'#'.repeat(index + 1)} Section ${index + 1}`)
      .join('\n\n') + '\n\nReasoning body.'
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByRole('button').textContent).toBe('思考')
    expect(view.queryByRole('heading')).toBeNull()

    fireEvent.click(view.getByText('思考'))
    const compact = view.container.querySelector('[data-markdown-variant="compact"]')
    expect(compact).not.toBeNull()
    expect(compact?.querySelectorAll('h1, h2, h3, h4, h5, h6')).toHaveLength(6)
    expect(compact?.querySelector('p')?.textContent).toBe('Reasoning body.')

    fireEvent.click(view.getByText('思考'))
    expect(view.queryByText('# Section 1')).toBeNull()
    expect(view.queryByRole('heading')).toBeNull()
  })

  it('keeps completed reasoning blocks mounted while the open streaming tail grows', () => {
    const first = '## Investigation\n\n**Check persistence**\n\n'
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: first }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    fireEvent.click(view.getByText('思考'))
    const heading = view.getByRole('heading', { name: 'Investigation' })
    const emphasis = view.getByText('Check persistence')
    const text = first + Array.from({ length: 8 }, (_, index) => `Paragraph ${index}.`).join('\n\n')
    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByRole('heading', { name: 'Investigation' })).toBe(heading)
    expect(view.getByText('Check persistence')).toBe(emphasis)
    expect(view.container.querySelector('[class*="thinkBody"]')?.textContent).not.toContain('##')
  })

  it('expanded Think drops the inline summary and renders prose without an IN card', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    fireEvent.click(view.getByText('思考'))
    expect(view.getAllByText(/Inspect the session/)).toHaveLength(1)
    expect(view.queryByText('IN')).toBeNull()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(view.container.querySelector('[class*="thinkBody"]')).not.toBeNull()
  })

  it('anchors the sticky-header selector: only an open Think row nests the disclosure row under data-expanded and data-open', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[
          { kind: 'reasoning', text: 'Inspect the session\nCheck persistence' },
          { kind: 'text', text: 'Answer' },
        ]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    // Collapsed: no `data-open`, so the sticky rule's gate never matches.
    expect(view.container.querySelector('[data-variant="think"] [data-open]')).toBeNull()
    fireEvent.click(view.getByText('思考'))
    expect(
      view.container.querySelector(
        '[data-variant="think"][data-expanded] [data-open] [data-disclosure-row]',
      ),
    ).not.toBeNull()
  })
})
