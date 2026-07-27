// @vitest-environment jsdom
/**
 * MenuView rendering spec, props-direct (slot-parity doctrine): closed store
 * renders null, groups render in roster order with pending rows as loading,
 * pointer picks route (source, index) back without stealing focus, and the
 * highlight is exposed through aria-activedescendant + aria-selected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { MenuState, TriggerHit } from '@deepseek-ai/dsh-client-ui-slash/client'
import { MenuView } from '../src/client/MenuView.tsx'

const hit: TriggerHit = {
  trigger: '/',
  query: 'g',
  quoted: false,
  position: 'leading',
  span: { start: 0, end: 2, draftRev: 1 },
}

const CLOSED: MenuState = { open: false, hit: null, generation: 0, groups: [], highlight: null }

function openState(partial?: Partial<MenuState>): MenuState {
  return {
    open: true,
    hit,
    generation: 1,
    groups: [
      { source: 'command', status: 'ready', items: [{ name: 'goal', description: 'Set up a goal', icon: '⚑' }, { name: 'plan' }] },
      { source: 'skill', status: 'pending', items: [] },
    ],
    highlight: { source: 'command', index: 0 },
    ...partial,
  }
}

afterEach(cleanup)

function mount(state: MenuState) {
  const menu = createSnapshotStore<MenuState>(state)
  const onPick = vi.fn()
  const view = render(<MenuView menu={menu} onPick={onPick} />)
  return { menu, onPick, view }
}

describe('MenuView', () => {
  it('renders null while closed and appears when the store opens', () => {
    const { menu, view } = mount(CLOSED)
    expect(view.container.childElementCount).toBe(0)
    act(() => { menu.set(openState()) })
    expect(screen.queryByRole('listbox')).not.toBeNull()
    act(() => { menu.set(CLOSED) })
    expect(view.container.childElementCount).toBe(0)
  })

  it('renders ready groups as option rows and pending groups as loading rows', () => {
    mount(openState())
    const options = screen.getAllByRole('option')
    expect(options.map(o => o.textContent)).toEqual(['⚑goalSet up a goal', 'plan'])
    expect(screen.queryByText('Loading skill…')).not.toBeNull()
  })

  it('renders contiguous candidate sections once without changing option indexes', () => {
    const { onPick } = mount(openState({
      groups: [{
        source: 'reference',
        status: 'ready',
        items: [
          { name: 'Folder · src/', section: '文件与文件夹' },
          { name: 'File · README.md', section: '文件与文件夹' },
          { name: 'Session · Research', section: 'Session 对话' },
        ],
      }],
      highlight: { source: 'reference', index: 0 },
    }))
    expect(screen.getAllByText('文件与文件夹')).toHaveLength(1)
    expect(screen.getAllByText('Session 对话')).toHaveLength(1)
    const options = screen.getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual([
      'Folder · src/',
      'File · README.md',
      'Session · Research',
    ])
    fireEvent.mouseDown(options[2]!)
    expect(onPick).toHaveBeenCalledWith('reference', 2)
  })

  it('exposes the highlight via aria-activedescendant and aria-selected', () => {
    mount(openState({ highlight: { source: 'command', index: 1 } }))
    const listbox = screen.getByRole('listbox')
    const options = screen.getAllByRole('option')
    expect(options[1]!.id).toBeTruthy()
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1]!.id)
    expect(options[1]!.getAttribute('aria-selected')).toBe('true')
    expect(options[0]!.getAttribute('aria-selected')).toBe('false')
  })

  it('omits aria-activedescendant without a highlight', () => {
    mount(openState({ highlight: null }))
    expect(screen.getByRole('listbox').getAttribute('aria-activedescendant')).toBeNull()
  })

  it('mousedown on a row picks (source, index) and prevents the focus steal', () => {
    const { onPick } = mount(openState())
    const options = screen.getAllByRole('option')
    const notPrevented = fireEvent.mouseDown(options[1]!)
    // fireEvent returns false when preventDefault was called.
    expect(notPrevented).toBe(false)
    expect(onPick).toHaveBeenCalledWith('command', 1)
  })
})
