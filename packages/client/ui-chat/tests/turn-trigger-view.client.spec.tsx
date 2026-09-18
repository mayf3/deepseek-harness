// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import {
  IconAgentPresetOutlineRegular, IconAlarmClockOutlineRegular, IconBranchOutlineRegular,
  IconContextInjectionOutlineRegular, IconCordisPluginOutlineRegular, IconGoalOutlineRegular,
  IconGlobeOutlineRegular, IconPaperPlaneOutlineRegular, IconQueueOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { TurnTriggerNodeView } from '../src/client/chat/TurnTriggerNodeView.tsx'
import { contextForm, contextProducer } from '../src/client/conversation-nodes/event-projection.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh, en } from '../src/client/locale.ts'

const t = ((key: keyof typeof zh) => zh[key]) as ChatNodeViewProps['t']

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function props(source: unknown, text = 'trigger content'): ChatNodeViewProps<'turn-trigger'> {
  return {
    node: {
      key: 'trigger:1',
      kind: 'turn-trigger',
      id: '1',
      target: 'chat',
      anchorSeq: 1,
      location: { kind: 'session' },
      visibility: 'visible',
      data: {
        kind: 'context',
        seq: 1,
        time: 1,
        source,
        content: [{ type: 'text', text }],
        producer: contextProducer(source),
        form: contextForm(source),
      },
    },
    t,
  } as ChatNodeViewProps<'turn-trigger'>
}

it.each([
  [{ kind: 'custom-extension' }, '', IconContextInjectionOutlineRegular],
  [{ kind: 'goal' }, '', IconGoalOutlineRegular],
  [{ kind: 'agent-message' }, '', IconPaperPlaneOutlineRegular],
  [{ kind: 'team-message' }, '', IconAgentPresetOutlineRegular],
  [{ kind: 'subagent-settled' }, '', IconAgentPresetOutlineRegular],
  [{ kind: 'webhook', provider: 'github' }, '', IconBranchOutlineRegular],
  [{ kind: 'webhook', provider: 'custom' }, '', IconGlobeOutlineRegular],
  [{ kind: 'plugin', plugin: 'schedule' }, '', IconAlarmClockOutlineRegular],
  [{ kind: 'plugin', plugin: 'tool-jobs' }, '', IconQueueOutlineRegular],
  [{ kind: 'plugin', plugin: 'cordis-host-runner' }, '', IconCordisPluginOutlineRegular],
] as const)('renders the source-family icon for %o', (source, text, ExpectedIcon) => {
  const actual = render(<TurnTriggerNodeView {...props(source, text)} />)
    .container.querySelector('[data-turn-trigger] button span svg')?.outerHTML
  const expected = render(<ExpectedIcon size={14} />).container.querySelector('svg')?.outerHTML
  expect(actual).toBe(expected)
})

it('shows only the explanation and original model-facing content when expanded', () => {
  const view = render(<TurnTriggerNodeView {...props({
    kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'hidden summary',
  }, 'background job finished')} />)

  expect(view.queryByText('hidden summary')).toBeNull()
  expect(view.queryByText('tool-jobs')).toBeNull()
  fireEvent.click(view.getByRole('button'))
  expect(view.getByText('这条通知触发了本轮回复。')).toBeTruthy()
  expect(view.getByText('background job finished')).toBeTruthy()
  expect(view.queryByText('hidden summary')).toBeNull()
  expect(view.queryByText('tool-jobs')).toBeNull()
  expect(view.container.querySelector('[data-context-fields]')).toBeNull()
})

it.each([
  { dictionary: zh, time: new Date(2026, 8, 18, 9, 5), expected: '09:05' },
  { dictionary: en, time: new Date(2026, 8, 18, 9, 5), expected: '09:05' },
  { dictionary: zh, time: new Date(2026, 8, 17, 9, 5), expected: '9月17日 09:05' },
  { dictionary: en, time: new Date(2026, 8, 17, 9, 5), expected: '9/17 09:05' },
  { dictionary: zh, time: new Date(2025, 11, 31, 9, 5), expected: '2025年12月31日 09:05' },
  { dictionary: en, time: new Date(2025, 11, 31, 9, 5), expected: '2025-12-31 09:05' },
])('renders the localized trigger timestamp $expected', ({ dictionary, time, expected }) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 18, 12))
  const input = props({ kind: 'goal' })
  const node = { ...input.node, data: { ...input.node.data, time: time.getTime() } }
  const view = render(<TurnTriggerNodeView {...input} node={node} t={makeTranslate(dictionary)} />)
  expect(view.getByText(expected).getAttribute('datetime')).toBe(time.toISOString())
})


it('preserves interleaved content and bounds long text inside a trigger notice', () => {
  const input = props({ kind: 'goal' })
  const content = [
    { type: 'text', text: 'first' }, { type: 'text', text: 'second' },
    { type: 'future-block', payload: 'opaque' }, { type: 'text', text: 'x'.repeat(20_001) },
  ] as unknown as typeof input.node.data.content
  const view = render(<TurnTriggerNodeView {...input}
    node={{ ...input.node, data: { ...input.node.data, content } }} t={makeTranslate(en)} />)
  fireEvent.click(view.getByRole('button'))
  const texts = [...view.container.querySelectorAll('[data-context-text]')]
  expect(texts[0]?.textContent).toBe('firstsecond')
  expect(texts[1]?.textContent).toContain('x'.repeat(20_000))
  expect(texts[1]?.textContent).not.toContain('x'.repeat(20_001))
  expect(texts[1]?.textContent).toContain('20001')
  expect(texts[0]?.nextElementSibling?.textContent).toContain('Unknown content block')
  fireEvent.click(view.getByText('Unknown content block', { exact: false }))
  expect(texts[0]?.nextElementSibling?.textContent).toContain('opaque')
})
