// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { useDismissOnOutsidePointer } from '../src/useDismissOnOutsidePointer.ts'

afterEach(cleanup)

function Popover({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(rootRef, open, setOpen)
  return (
    <div>
      <div ref={rootRef} data-testid="root">
        <button type="button">inside</button>
      </div>
      <button type="button" data-testid="outside">outside</button>
    </div>
  )
}

describe('useDismissOnOutsidePointer', () => {
  it('closes on an outside pointerdown and ignores inside ones', () => {
    const setOpen = vi.fn()
    const view = render(<Popover open setOpen={setOpen} />)
    fireEvent.pointerDown(view.getByText('inside'))
    expect(setOpen).not.toHaveBeenCalled()
    fireEvent.pointerDown(view.getByTestId('outside'))
    expect(setOpen).toHaveBeenCalledWith(false)
  })

  it('attaches no listener while closed and detaches on close', () => {
    const setOpen = vi.fn()
    const view = render(<Popover open={false} setOpen={setOpen} />)
    fireEvent.pointerDown(view.getByTestId('outside'))
    expect(setOpen).not.toHaveBeenCalled()

    view.rerender(<Popover open setOpen={setOpen} />)
    view.rerender(<Popover open={false} setOpen={setOpen} />)
    fireEvent.pointerDown(view.getByTestId('outside'))
    expect(setOpen).not.toHaveBeenCalled()
  })

  it('ignores a pointerdown whose target is not a DOM node', () => {
    const setOpen = vi.fn()
    render(<Popover open setOpen={setOpen} />)
    const event = new Event('pointerdown', { bubbles: true })
    // Shadow the prototype getter so the listener sees a non-Node target.
    Object.defineProperty(event, 'target', { get: () => ({}) })
    document.dispatchEvent(event)
    expect(setOpen).not.toHaveBeenCalled()
  })
})
