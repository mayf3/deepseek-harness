// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  ChatConversationViewNode, ConversationNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import {
  formatMessageClock, msUntilNextLocalMidnight, startOfLocalDay,
} from '../src/client/chat/message-chrome.ts'
import {
  CompactionNodeView, RetryNodeView, UnknownNodeView,
  UserMessageNodeView,
} from '../src/client/chat/MessageItem.tsx'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsPills } from '../src/client/chat/StatsPills.tsx'
import { zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null
const RETRY_ID = 'retry-fixture' as Extract<ConversationNode, { kind: 'model-retry' }>['retryId']

// Recency scans the whole transcript; a detached fixture is its own latest row.
const useDetachedChat: ChatNodeViewProps['useChat'] = bindSnapshotSelector({
  subscribe: () => () => {},
  getSnapshot: () => ({ order: [], nodes: new Map() }),
} as never)

interface MessageItemProps {
  readonly node: ConversationNode
  readonly t: ChatNodeViewProps['t']
  readonly referenceLabels?: readonly string[]
  readonly skillNames?: readonly string[]
}

/** Legacy-node fixture adapter for the independently registered renderers. */
function MessageItem({ node, t: translate, referenceLabels, skillNames }: MessageItemProps) {
  const kind = node.kind === 'assistant' ? 'assistant-step' : node.kind
  const viewNode: ChatConversationViewNode = {
    key: `fixture:${node.kind}:${node.seq}`,
    kind,
    id: String(node.seq),
    target: 'chat',
    anchorSeq: node.seq,
    location: { kind: 'session' },
    visibility: 'visible',
    data: node.kind === 'model-retry'
      ? { attempts: [node], current: node }
      : (node.kind === 'user' || node.kind === 'steering') && (referenceLabels !== undefined || skillNames !== undefined)
        ? {
          ...node,
          ...(referenceLabels === undefined ? {} : { referenceLabels }),
          ...(skillNames === undefined ? {} : { skillNames }),
        }
        : node,
  }
  const props = {
    node: viewNode, t: translate, renderMessageImages, openFile: vi.fn(), openSkill: vi.fn(), useChat: useDetachedChat,
  } as unknown as ChatNodeViewProps
  switch (node.kind) {
    case 'user':
    case 'steering':
      return <UserMessageNodeView {...props as ChatNodeViewProps<'user' | 'steering'>} />
    case 'compaction':
      return <CompactionNodeView {...props as ChatNodeViewProps<'compaction'>} />
    case 'model-retry':
      return <RetryNodeView {...props as ChatNodeViewProps<'model-retry'>} />
    case 'unknown':
      return <UnknownNodeView {...props as ChatNodeViewProps<'unknown'>} />
    default:
      throw new Error(`unsupported MessageItem fixture kind: ${node.kind}`)
  }
}

describe('MessageItem arms', () => {
  it('renders an adjacent session mention as a chip even without trailing whitespace', () => {
    const view = render(
      <MessageItem
        t={t}
        referenceLabels={['你好']}
        node={{
          kind: 'user',
          seq: 1,
          time: 1_000,
          content: [{ type: 'text', text: '@你好这个在讲啥' }] as never,
          source: null,
        }}
      />,
    )
    expect(view.container.querySelector('[data-ref-chip="session"]')?.textContent).toBe('你好')
    expect(view.container.querySelector('[data-ref-chip="session"] svg')).not.toBeNull()
    expect(view.getByText('这个在讲啥')).toBeTruthy()
    expect(view.getByText('引用会话 · 你好')).toBeTruthy()
  })

  it('renders the complete metadata-confirmed multi-word session label', () => {
    const view = render(
      <MessageItem
        t={t}
        referenceLabels={['Research notes']}
        node={{
          kind: 'user',
          seq: 1,
          time: 1_000,
          content: [{ type: 'text', text: '@Research notes what changed?' }] as never,
          source: null,
        }}
      />,
    )
    expect(view.container.querySelector('[data-ref-chip="session"]')?.textContent).toBe('Research notes')
    expect(view.getByText('what changed?')).toBeTruthy()
    expect(view.getByText('引用会话 · Research notes')).toBeTruthy()
  })

  it('renders no-extension paths as files and leaves sentence punctuation outside the reference', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'user',
        seq: 1,
        time: 1_000,
        content: [{ type: 'text', text: 'Read @Dockerfile and @src/README.md, please.' }] as never,
        source: null,
      }} />,
    )
    const files = [...view.container.querySelectorAll('[data-ref-chip="file"]')]
    expect(files.map(file => file.textContent)).toEqual(['Dockerfile', 'README.md'])
    expect(files.every(file => file.querySelector('svg') !== null)).toBe(true)
    expect(view.container.textContent).toContain('README.md, please.')
  })

  it('decorates a slash token as a skill chip only when the step resolved that skill', () => {
    const message = {
      kind: 'user' as const,
      seq: 1,
      time: 1_000,
      content: [{ type: 'text', text: '/123 then /demo-skill go' }] as never,
      source: null,
    }
    const plain = render(<MessageItem t={t} node={message} />)
    expect(plain.container.querySelectorAll('[data-ref-chip]').length).toBe(0)
    const resolved = render(<MessageItem t={t} node={message} skillNames={['demo-skill']} />)
    const chips = [...resolved.container.querySelectorAll('[data-ref-chip="skill"]')]
    expect(chips.map(chip => chip.textContent)).toEqual(['/demo-skill'])
    expect(resolved.container.textContent).toContain('/123 then ')
  })

  it('user bubbles expose clock / copy and neither branch nor edit; copy writes the text', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    // Same-day clock: construct "today at 14:24" so the label stays `HH:mm`.
    const now = new Date()
    const time = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 24).getTime()
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time,
        content: [{ type: 'text', text: 'hello bubble' }] as never,
        source: null,
      }}
      />,
    )
    expect(screen.getByText('14:24')).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '在新对话中分支' })).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('hello bubble')
  })

  it('user copy falls back to execCommand when clipboard.writeText is unavailable', () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    const exec = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: exec,
    })
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'fallback body' }] as never,
        source: null,
      }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('user copy never claims success when the host rejects the write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'quiet' }] as never,
        source: null,
      }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '复制成功' })).toBeNull()
  })

  it('copy swaps to the check success chrome, gates re-clicks, and reverts after a second', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'copied body' }] as never,
        source: null,
      }}
      />,
    )
    const copy = screen.getByRole('button', { name: '复制' })
    fireEvent.click(copy)
    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledTimes(1)
    // Two microtask ticks: writeClipboard's own await, then the .then that
    // lands the success chrome.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const done = screen.getByRole('button', { name: '复制成功' })
    fireEvent.click(done)
    expect(writeText).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('clears copy feedback work when the message unmounts', async () => {
    vi.useFakeTimers()
    let finishWrite!: () => void
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve }))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const view = render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'copied body' }] as never,
        source: null,
      }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    view.unmount()
    await act(async () => {
      finishWrite()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBe(0)

    const mounted = render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 2, time: 1_000,
        content: [{ type: 'text', text: 'copied body' }] as never,
        source: null,
      }}
      />,
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('consumed steering renders as a plain user bubble and keeps copy without branch', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const view = render(
      <MessageItem t={t} node={{
        kind: 'steering', messageId: 'steer-message', seq: 2, time: 1_000, turn: 1, source: null,
        content: [{ type: 'text', text: 'steer!' }, { type: 'image', data: 'x' }] as never,
      } as never}
      />,
    )
    expect(view.queryByText('插话')).toBeNull()
    expect(view.getByText('steer!')).toBeTruthy()
    expect(view.getByText(/附加内容块/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('steer!')
    expect(view.queryByRole('button', { name: '在新对话中分支' })).toBeNull()
  })

  it('unknown nodes retain the generic JSON row', () => {
    const unknownView = render(
      <MessageItem t={t} node={{ kind: 'unknown', seq: 4, type: 'surface/next', data: { x: 1 } } as never} />,
    )
    expect(unknownView.getByText(/未知 surface 事件：surface\/next/)).toBeTruthy()
  })

  it('a compaction marker discloses its summary and never shows the framed checkpoint', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'compaction', seq: 5, time: 1_000,
        summary: '## 摘要标题\n\n保留的事实。',
        summaryEventSeq: 4,
        shadowedItemCount: 16,
        shadowedTokenCount: 11_309,
      }}
      />,
    )
    const row = view.getByRole('button', { name: /上下文已压缩/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('已压缩 16 条历史记录（约 11309 tokens）')).toBeTruthy()
    expect(view.queryByText(/保留的事实/)).toBeNull()
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByRole('heading', { name: '摘要标题' })).toBeTruthy()
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('anchors the sticky-header selector: the compaction body sits under compactionRow only while open', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'compaction', seq: 5, time: 1_000,
        summary: '## 摘要标题\n\n保留的事实。',
        summaryEventSeq: 4,
        shadowedItemCount: 16,
        shadowedTokenCount: 11_309,
      }}
      />,
    )
    // Collapsed there is no body sibling, so the rule's `:has(.compactionBody)`
    // gate never matches.
    expect(view.container.querySelector('[class*="compactionRow"] [class*="compactionBody"]')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /上下文已压缩/ }))
    expect(view.container.querySelector('[class*="compactionRow"] [class*="compactionBody"]')).not.toBeNull()
  })

  it('a marker whose cited summary event fell outside the window is not expandable', () => {
    const view = render(<MessageItem t={t} node={{
      kind: 'compaction', seq: 6, time: 1_000, summary: null,
      summaryEventSeq: null, shadowedItemCount: null, shadowedTokenCount: null,
    }} />)
    const row = view.getByRole('button', { name: /上下文已压缩/ })
    expect(row).toHaveProperty('disabled', true)
    expect(row.getAttribute('aria-expanded')).toBeNull()
    expect(view.getByText('压缩摘要不可用')).toBeTruthy()
    fireEvent.click(row) // a disabled control stays collapsed
    expect(row.getAttribute('aria-expanded')).toBeNull()
  })

  it('collapses retry details behind the durable model retry status', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const view = render(
      <MessageItem
        t={t}
        node={{
          kind: 'model-retry',
          retryId: RETRY_ID,
          seq: 5,
          time: 10_000,
          retryState: 'scheduled',
          turn: 1,
          step: 0,
          provider: 'mock',
          mode: 'normal',
          policyKey: 'mock-normal',
          retry: 1,
          maxRetries: 2,
          delayMs: 2_500.4,
          failure: { code: 'TRANSPORT', message: '连接被重置' },
        }}
      />,
    )
    const details = view.container.querySelector('details')
    const summary = view.container.querySelector('summary')
    expect(details?.open).toBe(false)
    expect(details?.dataset.active).toBe('true')
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 3s')
    expect(view.getByText('重试延迟：').parentElement?.textContent).toBe('重试延迟：2500毫秒')
    expect(view.getByText('失败原因：').parentElement?.textContent).toBe('失败原因：连接被重置')

    act(() => { vi.advanceTimersByTime(1_100) })
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 2s')
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 1s')

    view.rerender(
      <MessageItem
        t={t}
        node={{
          kind: 'model-retry',
          retryId: RETRY_ID,
          seq: 6,
          time: 12_100,
          retryState: 'scheduled',
          turn: 2,
          step: 0,
          provider: 'mock',
          mode: 'normal',
          policyKey: 'mock-normal',
          retry: 2,
          maxRetries: 2,
          delayMs: 3_500.4,
          failure: { code: 'TRANSPORT', message: '再次断开' },
        }}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（2/2） · 4s')

    if (summary === null) throw new Error('retry summary missing')
    fireEvent.click(summary)
    expect(details?.open).toBe(true)

    view.rerender(
      <MessageItem t={t} node={{
        kind: 'model-retry',
        retryId: RETRY_ID,
        seq: 6,
        time: 12_100,
        retryState: 'started',
        turn: 2,
        step: 0,
        provider: 'mock',
        mode: 'normal',
        policyKey: 'mock-normal',
        retry: 2,
        maxRetries: 2,
        delayMs: 3_500.4,
        failure: { code: 'TRANSPORT', message: '再次断开' },
      }}
      />,
    )
    expect(details?.dataset.active).toBeUndefined()
    expect(view.getByRole('status').textContent).toBe('已重试模型请求（2/2） · 4s')

    view.rerender(
      <MessageItem t={t} node={{
        kind: 'model-retry',
        retryId: RETRY_ID,
        seq: 7,
        time: 12_100,
        retryState: 'started',
        turn: 3,
        step: 0,
        provider: 'mock',
        mode: 'always',
        policyKey: 'mock-always',
        retry: 3,
        delayMs: 3_500.4,
        failure: { code: 'TRANSPORT', message: '继续重试' },
      }}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('已重试模型请求（3/∞） · 4s')

    view.rerender(
      <MessageItem t={t} node={{
        kind: 'model-retry',
        retryId: RETRY_ID,
        seq: 8,
        time: 12_100,
        retryState: 'cancelled',
        turn: 4,
        step: 0,
        provider: 'mock',
        mode: 'normal',
        policyKey: 'mock-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 3_500.4,
        failure: { code: 'TRANSPORT', message: '用户取消' },
      }}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('模型请求重试已取消（1/2） · 4s')
  })

})

describe('formatMessageClock', () => {
  const now = new Date(2026, 6, 29, 10, 0).getTime()

  it('keeps HH:mm on the same calendar day', () => {
    expect(formatMessageClock(new Date(2026, 6, 29, 14, 24).getTime(), t, now)).toBe('14:24')
  })

  it('prefixes month and day across days in the same year', () => {
    expect(formatMessageClock(new Date(2026, 0, 1, 14, 24).getTime(), t, now)).toBe('1月1日 14:24')
  })

  it('prefixes year, month, and day across years', () => {
    expect(formatMessageClock(new Date(2025, 11, 31, 9, 5).getTime(), t, now)).toBe('2025年12月31日 09:05')
  })

  it('arms the next local midnight from an in-day instant', () => {
    const noon = new Date(2026, 6, 29, 12, 0).getTime()
    expect(startOfLocalDay(noon)).toBe(new Date(2026, 6, 29).getTime())
    expect(msUntilNextLocalMidnight(noon)).toBe(12 * 3_600_000)
  })
})

describe('useCalendarDay boundary refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('widens a same-day user clock after local midnight', () => {
    const dayStart = new Date(2026, 6, 29, 23, 50).getTime()
    vi.setSystemTime(dayStart)
    const time = new Date(2026, 6, 29, 14, 24).getTime()
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time,
        content: [{ type: 'text', text: 'night bubble' }] as never,
        source: null,
      }}
      />,
    )
    expect(screen.getByText('14:24')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(msUntilNextLocalMidnight(dayStart) + 1)
    })
    expect(screen.getByText('7月29日 14:24')).toBeTruthy()
  })
})

describe('small branch tails', () => {
  it('AssistantMarkdown hides settled single-line reasoning until expanded', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'one-liner' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.queryByText('one-liner')).toBeNull()
    fireEvent.click(view.getByText('思考'))
    expect(view.getByText('one-liner')).toBeTruthy()
  })

  it('StatsPills omits the cache-hit segment when no input accounting exists at all', () => {
    // Cache hit is null only when all three prompt buckets are zero (pure
    // output accounting) — any billed input makes it a real 0%.
    const nodes = [{
      kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1, blocks: [], usage: { outputTokens: 10 },
    }] as const
    const snap = chatSnapshotFixture({ nodes })
    const source = { getSnapshot: () => snap, subscribe: () => () => {} }
    const view = render(
      <StatsPills
        usePerformanceUsage={selector => selector('detailed')}
        t={t}
        useChat={bindSnapshotSelector(source)}
        useProjection={(key: string) => key === 'tokenUsage'
          ? { uncachedInputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
          : undefined}
      />,
    )
    // The untimed counts pill renders static, so the usage pill is the only button.
    const [usagePill] = [...view.getAllByRole('button')] as [HTMLElement]
    expect(view.getByText('1 轮 1 步').closest('button')).toBeNull()
    expect(usagePill.textContent).toBe('10 tok')
    // Pure output accounting still reaches the usage pill's click-open dialog rows.
    fireEvent.click(usagePill)
    const dialog = view.getByRole('dialog')
    expect(dialog.textContent).toContain('输出10 tok')
    expect(dialog.textContent).not.toContain('缓存命中')
  })
})

describe('user file attachments', () => {
  it('renders one card per durable file block with its name and compact size', () => {
    const view = render(
      <MessageItem
        t={t}
        node={{
          kind: 'user',
          seq: 1,
          time: 1_000,
          content: [
            { type: 'file', attachment: { attachmentId: 'sha256:cd', name: 'notes.pdf', bytes: 3 * 1024 * 1024 + 200 * 1024 } },
            { type: 'file', attachment: { attachmentId: 'sha256:ef', name: 'tiny.txt', bytes: 12 } },
            { type: 'file', attachment: { attachmentId: 'sha256:aa', name: 'mid.csv', bytes: 500 * 1024 } },
            { type: 'text', text: 'summarize these' },
          ] as never,
          source: null,
        }}
      />,
    )
    expect(view.getByTitle('notes.pdf').textContent).toContain('3.2MB')
    expect(view.getByTitle('tiny.txt').textContent).toContain('12B')
    expect(view.getByTitle('mid.csv').textContent).toContain('500KB')
    const icons = ['notes.pdf', 'tiny.txt', 'mid.csv'].map(name =>
      view.getByTitle(name).querySelector('svg')?.innerHTML,
    )
    expect(new Set(icons).size).toBe(icons.length)
    expect(view.getByText('summarize these')).toBeTruthy()
  })
})
