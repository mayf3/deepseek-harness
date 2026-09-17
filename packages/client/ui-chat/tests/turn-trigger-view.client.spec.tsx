// @vitest-environment jsdom

import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import {
  IconAgentPresetOutlineRegular, IconAlarmClockOutlineRegular, IconBranchOutlineRegular,
  IconContextInjectionOutlineRegular, IconCordisPluginOutlineRegular, IconGoalOutlineRegular,
  IconGlobeOutlineRegular, IconQueueOutlineRegular, IconSendOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { TurnTriggerNodeView } from '../src/client/chat/TurnTriggerNodeView.tsx'
import { contextForm, contextProducer } from '../src/client/conversation-nodes/event-projection.ts'
import { zh } from '../src/client/locale.ts'

const t = ((key: keyof typeof zh) => zh[key]) as ChatNodeViewProps['t']

afterEach(cleanup)

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
  [{ kind: 'agent-message' }, '', IconSendOutlineRegular],
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
