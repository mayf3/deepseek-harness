// @vitest-environment jsdom
/**
 * The two conversation-adjacent surfaces: the new-session chip naming the
 * next session's preset, and the session header's read-only label. The split
 * is the host's rule — a session's history is produced under its preset's
 * tools, so the choice is only ever offered before one starts.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionRetainInfo } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { AgentPresetLabel } from '../src/client/AgentPresetLabel.tsx'
import type { AgentPresetLabelProps } from '../src/client/AgentPresetLabel.tsx'
import { AgentPresetSeat } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSeatProps } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSettingsState } from '../src/client/settings-store.ts'
import type { AgentPresetSeatState } from '../src/client/seat-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const ROSTER_READY: AgentPresetSettingsState = {
  status: 'ready',
  error: null,
  options: [{ id: 'standard' }, { id: 'mine' }],
}

const SEAT_READY: AgentPresetSeatState = {
  current: 'standard',
  options: [
    { id: 'standard' },
    { id: 'mine' },
  ],
  busy: false,
  error: null,
  introduce: false,
}

const useSessionRetainInfo = <Selected,>(selector: (value: undefined) => Selected): Selected => selector(undefined)

/** The runtime's own `{name}` substitution, so a test reads the shown text. */
function translate(key: keyof typeof en, params?: Record<string, unknown>): string {
  const template = en[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function seatTrigger(): HTMLElement {
  const button = screen.getAllByRole('button').find(item => item.getAttribute('aria-haspopup') === 'menu')
  if (button === undefined) throw new Error('No preset selection trigger')
  return button
}

function renderSeat(
  state: Partial<AgentPresetSeatState> = {},
  select: () => Promise<string | undefined> = () => Promise.resolve(undefined),
  session?: { id: string; retainInfo: SessionRetainInfo | undefined },
  enabled = true,
) {
  const store = createSnapshotStore<AgentPresetSeatState>({ ...SEAT_READY, ...state })
  const developerTools = createSnapshotStore(enabled)
  const actions = { load: vi.fn(() => Promise.resolve()), select: vi.fn(select), introduced: vi.fn() }
  const props = {
    ...actions,
    sessionId: session === undefined ? undefined : SessionId(session.id),
    useDeveloperTools: bindSnapshotSelector(developerTools),
    useAgentPresetSeat: bindSnapshotSelector(store),
    useSessionRetainInfo: session === undefined
      ? useSessionRetainInfo
      : <Selected,>(selector: (value: SessionRetainInfo | undefined) => Selected) => selector(session.retainInfo),
    t: translate,
  } as AgentPresetSeatProps
  render(<AgentPresetSeat {...props} />)
  return { ...actions, developerTools, store }
}

function renderLabel(
  summary: { blank: boolean; projectionValues?: { agentPreset?: string | null } } | undefined,
  roster: Partial<AgentPresetSettingsState> = {},
) {
  // The chip and the label read the same roster, metadata included.
  const store = createSnapshotStore<AgentPresetSettingsState>({
    ...ROSTER_READY, options: SEAT_READY.options, ...roster,
  })
  const sessions = createSnapshotStore({ byId: summary === undefined ? {} : { s1: summary } })
  const load = vi.fn(() => Promise.resolve())
  const view = render(<AgentPresetLabel {...({
    load,
    sessionId: 's1',
    useSessions: bindSnapshotSelector(sessions),
    useAgentPresets: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as AgentPresetLabelProps)} />)
  return { load, view, store }
}

describe('the new-session chip', () => {
  it('renders nothing while Developer tools are off', () => {
    renderSeat({}, undefined, undefined, false)

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders only for a Session retained by the main view', () => {
    renderSeat({}, undefined, {
      id: 's1', retainInfo: { referenceCount: 1, retainedBy: { mainView: 1 } },
    })
    expect(seatTrigger()).toBeTruthy()
    cleanup()

    renderSeat({}, undefined, { id: 's1', retainInfo: undefined })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reads the roster once and shows the staged preset by name', async () => {
    const actions = renderSeat()

    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
    expect(seatTrigger().textContent).toContain(en.presetStandardName)
    expect(seatTrigger().getAttribute('title')).toBe(en.seatHint)
  })

  it('offers each preset with what it is for', () => {
    renderSeat()

    fireEvent.click(seatTrigger())

    // The id alone never said what a preset does; the description is the
    // whole reason a preset can publish metadata at all.
    expect(screen.getByText(en.presetStandardDescription)).toBeTruthy()
    // A preset that published none still reads as a row, with its id standing
    // in for the name.
    expect(screen.getByText(en.noDescription)).toBeTruthy()
    expect(screen.getByText('mine')).toBeTruthy()
  })

  it('closes the picker immediately when developer tools turn off without changing the staged preset', () => {
    const actions = renderSeat()
    fireEvent.click(seatTrigger())
    expect(screen.getByText(en.presetStandardDescription)).toBeTruthy()
    act(() => { actions.developerTools.set(false) })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(en.presetStandardDescription)).toBeNull()
    expect(actions.select).not.toHaveBeenCalled()
    act(() => { actions.developerTools.set(true) })
    expect(seatTrigger().getAttribute('aria-expanded')).toBe('false')
    expect(seatTrigger().textContent).toContain(en.presetStandardName)
  })

  it('falls back to the id when the staged preset published no name', () => {
    renderSeat({ current: 'mine' })

    expect(seatTrigger().textContent).toContain('mine')
  })

  it('shows the staged id until a stale roster contains it', () => {
    renderSeat({ current: 'arriving' })

    expect(seatTrigger().textContent).toContain('arriving')
  })

  it('stages the picked preset and closes the menu', () => {
    const actions = renderSeat()
    fireEvent.click(seatTrigger())

    fireEvent.click(screen.getByText('mine'))

    expect(actions.select).toHaveBeenCalledWith('mine')
    expect(seatTrigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('disables the trigger while a switch is in flight', () => {
    renderSeat({ busy: true })

    expect(seatTrigger()).toHaveProperty('disabled', true)
  })

  it('shows a refused switch on the trigger', () => {
    renderSeat({ error: 'session has already started' })

    expect(seatTrigger().getAttribute('title')).toBe('session has already started')
  })

  it('renders nothing before the roster arrives or when there is none', () => {
    const empty = renderSeat({ options: [] })
    expect(empty).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()

    renderSeat({ current: '' })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('closes on an outside dismissal', () => {
    renderSeat()
    fireEvent.click(seatTrigger())

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(seatTrigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens mode help without selecting and returns keyboard focus after Escape', () => {
    const actions = renderSeat()
    const trigger = screen.getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` })
    trigger.focus()
    fireEvent.click(trigger)

    expect(screen.getByRole('dialog', { name: en.presetStandardName })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: en.modeExplanation }))
    fireEvent.click(screen.getByRole('tab', { name: en.howToUse }))
    expect(screen.getByRole('tab', { name: en.howToUse }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(actions.select).not.toHaveBeenCalled()
  })

  it('uses only a custom preset description even when it names a built-in id', () => {
    const actions = renderSeat({ options: [{ id: 'standard', name: 'My workflow', description: 'Our review workflow' }] })
    fireEvent.click(screen.getByRole('button', { name: `${en.modeExplanation}: My workflow` }))

    expect(screen.getByRole('dialog', { name: 'My workflow' }).textContent).toContain('Our review workflow')
    expect(screen.queryByRole('tab')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actions.select).not.toHaveBeenCalled()
  })

  it('forgets open help when developer tools turn off', () => {
    const actions = renderSeat()
    fireEvent.click(screen.getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` }))
    act(() => { actions.developerTools.set(false) })
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { actions.developerTools.set(true) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([
    { name: 'no presets', options: [] },
    { name: 'another preset', options: [{ id: 'mine' }] },
  ])('keeps help closed when the current preset returns after removal leaves $name', ({ options }) => {
    const actions = renderSeat()
    const before = actions.store.getSnapshot()
    fireEvent.click(screen.getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` }))
    expect(screen.getByRole('dialog', { name: en.presetStandardName })).toBeTruthy()

    act(() => { actions.store.set({ ...before, options }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { actions.store.set(before) })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` })).toBeTruthy()
    expect(actions.select).not.toHaveBeenCalled()
  })
})

describe('a refused switch', () => {
  it('announces the reason instead of letting the label snap back in silence', async () => {
    // The banner's own timer has to be a fake one from the start, or the
    // lifetime assertion below would wait out its real nine seconds.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const reason = 'failed to import loader entry live-on-mac (@deepseek-ai/dsh-also-gone)'
      renderSeat({}, () => Promise.resolve(reason))

      fireEvent.click(seatTrigger())
      fireEvent.click(screen.getByRole('menuitem', { name: /mine/ }))

      // The host refuses a mount discovery reported healthy, so this banner is
      // the only place the cause appears — the chip has already reverted and
      // the settings row shows the preset as fine.
      const banner = await screen.findByRole('alert')
      expect(banner.textContent).toContain(reason)
      expect(banner.textContent).toContain('mine')

      // Transient by design: it holds long enough to read a cause that names
      // packages, then leaves rather than sitting over the screen.
      act(() => { vi.advanceTimersByTime(9001) })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing when the switch lands', async () => {
    const actions = renderSeat()

    fireEvent.click(seatTrigger())
    fireEvent.click(screen.getByRole('menuitem', { name: /mine/ }))

    await waitFor(() => { expect(actions.select).toHaveBeenCalledWith('mine') })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the chip introduce cue', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Character spans carry inline animation delays; nothing else does. */
  function delayedChars(): HTMLElement[] {
    return Array.from(seatTrigger().querySelectorAll<HTMLElement>('[style]'))
  }

  it('reveals a long Latin name inside the shared window, then acknowledges', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: 'CreatorMode' }],
      introduce: true,
    })

    // Eleven characters split the 200ms window into 20ms steps, where the
    // fixed 40ms tick would have doubled the run for a Latin name.
    const chars = delayedChars()
    expect(chars.map(span => span.textContent).join('')).toBe('CreatorMode')
    expect(chars[0]!.style.animationDelay).toBe('150ms')
    expect(chars[1]!.style.animationDelay).toBe('170ms')
    expect(chars[10]!.style.animationDelay).toBe('350ms')

    // 150 delay + 200 window + 400 fade: acknowledged only once the last
    // character has settled, and the label is plain text again after.
    act(() => { vi.advanceTimersByTime(749) })
    expect(actions.introduced).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })

  it('keeps the per-tick cap for a short CJK name', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: '创造模式' }],
      introduce: true,
    })

    // Four characters fit under the window, so the 40ms tick applies as-is.
    const chars = delayedChars()
    expect(chars).toHaveLength(4)
    expect(chars[1]!.style.animationDelay).toBe('190ms')
    expect(chars[3]!.style.animationDelay).toBe('270ms')
  })

  it('starts a one-character name with no stagger at all', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: 'C' }],
      introduce: true,
    })

    expect(delayedChars()[0]!.style.animationDelay).toBe('150ms')
    act(() => { vi.advanceTimersByTime(550) })
    expect(actions.introduced).toHaveBeenCalledTimes(1)
  })

  it('skips the run under reduced motion and acknowledges at once', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const actions = renderSeat({ introduce: true })

    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })

  it('acknowledges an empty staged name without arming a run', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: '' }],
      introduce: true,
    })

    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })
})

describe('the session-header label', () => {
  it('names the preset the session runs, and never offers a switch', async () => {
    const { load } = renderLabel({
      blank: false,
      projectionValues: { agentPreset: 'standard' },
    })

    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1) })
    // Reading details never offers a change to the task's preset.
    expect(screen.getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByTitle(en.presetStandardDescription).textContent).toBe(en.presetStandardName)
  })

  it('opens read-only mode help from a running task and restores focus on close', () => {
    renderLabel({ blank: false, projectionValues: { agentPreset: 'standard' } })
    const trigger = screen.getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` })
    trigger.focus()
    fireEvent.click(trigger)

    expect(screen.getByRole('dialog', { name: en.presetStandardName })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('displays the custom description without claiming built-in capabilities', () => {
    renderLabel({ blank: false, projectionValues: { agentPreset: 'standard' } }, {
      options: [{ id: 'standard', name: 'Review only', description: 'Describe changes for review' }],
    })
    fireEvent.click(screen.getByRole('button', { name: `${en.modeExplanation}: Review only` }))
    expect(screen.getByRole('dialog', { name: 'Review only' }).textContent).toContain('Describe changes for review')
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('keeps help closed when the session preset returns after leaving the roster', () => {
    const { store } = renderLabel({ blank: false, projectionValues: { agentPreset: 'standard' } })
    const before = store.getSnapshot()
    fireEvent.click(screen.getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` }))
    expect(screen.getByRole('dialog', { name: en.presetStandardName })).toBeTruthy()

    act(() => { store.set({ ...before, options: [{ id: 'mine' }] }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTitle(en.headerHint).textContent).toBe('standard')
    act(() => { store.set(before) })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` })).toBeTruthy()
  })

  it('falls back to the id, and to the generic hint, when metadata is absent', () => {
    renderLabel({ blank: true, projectionValues: { agentPreset: 'mine' } })

    expect(screen.getByTitle(en.headerHint).textContent).toBe('mine')
  })

  it('shows the id until the roster resolves it', () => {
    renderLabel({
      blank: false,
      projectionValues: { agentPreset: 'standard' },
    }, { options: [] })

    // The session's own summary is the authority on which preset it runs; the
    // roster only supplies the display name, and its arrival is a later frame.
    expect(screen.getByTitle(en.headerHint).textContent).toBe('standard')
  })

  it('renders nothing, and reads no roster, when the session records no preset', async () => {
    const absent = renderLabel({ blank: true })
    expect(absent.view.container.firstChild).toBeNull()
    cleanup()

    // A session the list has not caught up to is the same answer: a deployment
    // that composes no presets must not pay for a roster read per header.
    const unknown = renderLabel(undefined)
    expect(unknown.view.container.firstChild).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(absent.load).not.toHaveBeenCalled()
    expect(unknown.load).not.toHaveBeenCalled()
  })
})
