// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Shimmer, ShimmerText } from '../src/Shimmer.tsx'

afterEach(cleanup)

describe('Shimmer', () => {
  it('retains real text and controls while one inert decoration covers icons and text', () => {
    const open = vi.fn()
    const row = (active: boolean, title: string) => (
      <Shimmer active={active}>
        <svg aria-hidden="true"><path d="M0 0L8 8" /></svg>
        <ShimmerText>{title}</ShimmerText>
        <button type="button" onClick={open}><ShimmerText>file.ts</ShimmerText></button>
      </Shimmer>
    )
    const view = render(row(true, 'Read'))
    const title = view.getByText('Read')
    const button = view.getByRole('button', { name: 'file.ts' })
    const decoration = view.container.querySelector('[inert]')!
    expect(decoration.getAttribute('aria-hidden')).toBe('true')
    expect(decoration.querySelector('svg')).not.toBeNull()
    expect([...decoration.querySelectorAll('[data-shimmer-text]')].map(node => node.getAttribute('data-shimmer-text')))
      .toEqual(['Read', 'file.ts'])
    expect(view.container.textContent).toBe('Readfile.ts')
    fireEvent.click(button)
    expect(open).toHaveBeenCalledOnce()

    view.rerender(row(true, 'Reading'))
    expect(view.getByText('Reading')).toBe(title)
    expect(view.getByRole('button', { name: 'file.ts' })).toBe(button)
    expect(view.container.querySelector('[inert]')).toBe(decoration)

    view.rerender(row(false, 'Read'))
    expect(view.getByText('Read')).toBe(title)
    expect(view.getByRole('button', { name: 'file.ts' })).toBe(button)
    expect(view.container.querySelector('[inert]')).toBeNull()
    expect(view.container.querySelectorAll('svg')).toHaveLength(1)
  })
})
