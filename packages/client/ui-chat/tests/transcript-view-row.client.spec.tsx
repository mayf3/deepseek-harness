// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TranscriptViewRow, type TranscriptViewRowProps } from '../src/client/settings/TranscriptViewRow.tsx'
import { PerformanceUsageRow } from '../src/client/settings/PerformanceUsageRow.tsx'
import type { LinkOpening, PerformanceUsageMode, TranscriptViewMode } from '../src/chat-settings.ts'
import { LinkOpeningRow } from '../src/client/settings/LinkOpeningRow.tsx'
import { en, zh } from '../src/client/locale.ts'

afterEach(cleanup)

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {}, jobsBySession: {},
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }))
}

function noPendingInteraction() {
  return bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map()))
}

// The resource hook the resources plugin merges into GlobalStandardProps; this row reads no address.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

function mount(mode: TranscriptViewMode = 'compact', dictionary: typeof en | typeof zh = en) {
  const source = createSnapshotStore<TranscriptViewMode>(mode)
  const setTranscriptView = vi.fn((next: TranscriptViewMode) => { source.set(next) })
  const props: TranscriptViewRowProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessions: emptySessions(),
    useSessionStatus: noPendingInteraction(),
    useWorkspaces: emptyWorkspaces(),
    useSessionRetainInfo: () => undefined,
    useResource,
    useTranscriptView: bindSnapshotSelector(source),
    setTranscriptView,
    t: makeTranslate(dictionary),
  }
  render(<TranscriptViewRow {...props} />)
  return { setTranscriptView, props }
}

describe('TranscriptViewRow', () => {
  it('explains the preference and shows Compact by default', () => {
    mount()
    expect(screen.getByText('Conversation display')).toBeDefined()
    expect(screen.getByText('Controls process content in completed turns')).toBeDefined()
    expect(screen.getByRole('button', { name: /Compact/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('selects Normal and follows the mirrored value', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: /Compact/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Normal' }))
    expect(b.setTranscriptView).toHaveBeenCalledWith('normal')
    const trigger = screen.getByRole('button', { name: /Normal/ })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Compact' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: 'Compact' })).toBeNull()
  })

  it('shows the conversation-display values in Chinese', () => {
    mount('compact', zh)
    fireEvent.click(screen.getByRole('button', { name: '紧凑' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '标准' }))
    expect(screen.getByRole('button', { name: '标准' })).toBeDefined()
  })
})


describe('LinkOpeningRow', () => {
  it('follows browser availability without clearing the saved destination', () => {
    const b = mount()
    const browserAvailable = createSnapshotStore(false)
    const source = createSnapshotStore<LinkOpening>('new-tab')
    render(<LinkOpeningRow
      {...b.props}
      useLinkOpening={bindSnapshotSelector(source)}
      useBrowserAvailable={bindSnapshotSelector(browserAvailable)}
      setLinkOpening={vi.fn()}
    />)
    expect(screen.queryByText('Open chat links in')).toBeNull()
    act(() => { browserAvailable.set(true) })
    expect(screen.getByRole('button', { name: 'New browser tab' })).toBeDefined()
    act(() => { browserAvailable.set(false) })
    expect(screen.queryByText('Open chat links in')).toBeNull()
    expect(source.getSnapshot()).toBe('new-tab')
  })

  it.each([
    [en, 'Open chat links in', 'Built-in browser', 'New browser tab'],
    [zh, '聊天链接打开方式', '内置浏览器', '浏览器新标签页'],
  ] as const)('selects either destination using localized labels (%s)', (dictionary, title, sidebar, newTab) => {
    const b = mount('compact', dictionary)
    const source = createSnapshotStore<LinkOpening>('sidebar')
    const setLinkOpening = vi.fn((destination: LinkOpening) => { source.set(destination) })
    render(<LinkOpeningRow
      {...b.props}
      useLinkOpening={bindSnapshotSelector(source)}
      useBrowserAvailable={bindSnapshotSelector(createSnapshotStore(true))}
      setLinkOpening={setLinkOpening}
    />)
    expect(screen.getByText(title)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: sidebar }))
    fireEvent.click(screen.getByRole('menuitem', { name: newTab }))
    expect(setLinkOpening).toHaveBeenLastCalledWith('new-tab')
    fireEvent.click(screen.getByRole('button', { name: newTab }))
    fireEvent.click(screen.getByRole('menuitem', { name: sidebar }))
    expect(setLinkOpening).toHaveBeenLastCalledWith('sidebar')
    expect(screen.getByRole('button', { name: sidebar }).getAttribute('aria-expanded')).toBe('false')
    expect(b.setTranscriptView).not.toHaveBeenCalled()
  })
})

describe('PerformanceUsageRow', () => {
  it('selects compact statistics independently of conversation display', () => {
    const b = mount()
    const source = createSnapshotStore<PerformanceUsageMode>('detailed')
    const setPerformanceUsage = vi.fn((mode: PerformanceUsageMode) => { source.set(mode) })
    render(<PerformanceUsageRow
      {...b.props}
      usePerformanceUsage={bindSnapshotSelector(source)}
      setPerformanceUsage={setPerformanceUsage}
    />)
    expect(screen.getByText('Performance & usage')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Detailed' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compact' }))
    expect(setPerformanceUsage).toHaveBeenCalledWith('compact')
    expect(screen.getAllByRole('button', { name: 'Compact' })).toHaveLength(2)
    expect(b.setTranscriptView).not.toHaveBeenCalled()
  })
})
