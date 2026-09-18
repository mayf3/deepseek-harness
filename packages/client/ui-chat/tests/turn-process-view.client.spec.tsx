// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { TurnProcessNodeView } from '../src/client/chat/TurnProcessNodeView.tsx'
import { en, zh } from '../src/client/locale.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const startedAt = new Date(2026, 8, 18, 12).getTime()

function props(reason: 'running' | 'completed' | 'aborted' | 'error', dictionary = en, setOpen = vi.fn()): ChatNodeViewProps<'turn-process'> {
  const spec = {
    turn: 1, controlAnchorSeq: 1, processStartSeq: 2, answerAnchorSeq: null,
    answerStep: null, inlineReasoning: false, messageCount: 1, toolCallCount: 0, subagentCount: 0,
  }
  return {
    node: {
      key: 'turn-process:1', kind: 'turn-process', id: '1', target: 'chat', anchorSeq: 1,
      visibility: 'visible', data: spec,
      location: {
        kind: 'turn',
        turn: {
          turn: 1, status: reason === 'running' ? 'open' : 'closed', steps: [],
          data: { get: () => undefined },
          start: { type: 'turn/start', seq: 1, time: startedAt, data: { turn: 1 } },
          end: reason === 'running' ? undefined : {
            type: 'turn/end', seq: 3, time: startedAt + 5000, data: { turn: 1, reason: { kind: reason } },
          },
        },
      },
    },
    turnProcess: { spec, foldable: true, hasContent: true, open: true, setOpen },
    t: makeTranslate(dictionary),
  } as unknown as ChatNodeViewProps<'turn-process'>
}

it.each([
  { dictionary: en, running: 'Deep diving...', completed: 'Worked', aborted: 'Stopped', error: 'Failed' },
  { dictionary: zh, running: '深度求索中', completed: '已完成工作', aborted: '已停止', error: '处理失败' },
])('announces lifecycle transitions independently of timer ticks in $running', ({ dictionary, running, ...labels }) => {
  vi.useFakeTimers()
  vi.setSystemTime(startedAt + 1000)
  const view = render(<TurnProcessNodeView {...props('running', dictionary)} />)
  const status = view.getByRole('status')
  expect(status.textContent).toBe(running)
  expect(status.getAttribute('aria-live')).toBe('polite')
  expect(status.getAttribute('aria-atomic')).toBe('true')
  expect(status.closest('button')).toBeNull()
  const before = view.getByRole('button').textContent
  const observer = new MutationObserver(() => {})
  observer.observe(status, { childList: true, characterData: true, subtree: true })
  try {
    act(() => { vi.advanceTimersByTime(2000) })
    expect(view.getByRole('button').textContent).not.toBe(before)
    expect(view.getByRole('status')).toBe(status)
    expect(status.textContent).toBe(running)
    expect(observer.takeRecords()).toEqual([])
    for (const reason of ['completed', 'aborted', 'error'] as const) {
      view.rerender(<TurnProcessNodeView {...props(reason, dictionary)} />)
      expect(view.getByRole('status')).toBe(status)
      expect(status.textContent).toBe(labels[reason])
      expect(vi.getTimerCount()).toBe(0)
    }
  } finally {
    observer.disconnect()
  }
})

it.each(['running', 'aborted', 'error'] as const)('keeps %s expanded, disabled, and without a disclosure arrow', (reason) => {
  vi.useFakeTimers()
  vi.setSystemTime(startedAt + 1000)
  const setOpen = vi.fn()
  const input = props(reason, en, setOpen)
  const view = render(<TurnProcessNodeView {...input} />)
  const button = view.getByRole('button') as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(button.querySelector('svg')).toBeNull()
  fireEvent.click(button)
  expect(setOpen).not.toHaveBeenCalled()
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps completed work collapsible with its elapsed time', () => {
  const setOpen = vi.fn()
  const input = props('completed', en, setOpen)
  const view = render(<TurnProcessNodeView {...input} />)
  const button = view.getByRole('button', { name: 'Took 5s' }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  expect(button.querySelector('svg')).not.toBeNull()
  fireEvent.click(button)
  expect(setOpen).toHaveBeenCalledWith(false)
})
