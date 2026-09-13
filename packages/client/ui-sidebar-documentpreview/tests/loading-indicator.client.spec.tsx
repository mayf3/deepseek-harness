// @vitest-environment jsdom
/** The shared loading status: visible label by default, icon-only on request. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LoadingIndicator } from '../src/client/LoadingIndicator.tsx'

afterEach(cleanup)

describe('LoadingIndicator', () => {
  it('shows the label beside the spinner by default', () => {
    const { getByRole } = render(<LoadingIndicator label="Reading…" />)
    const status = getByRole('status')
    expect(status.textContent).toBe('Reading…')
    expect(status.getAttribute('aria-label')).toBeNull()
  })

  it('moves the label to the accessible name when icon-only', () => {
    const { getByRole } = render(<LoadingIndicator label="Reading…" iconOnly />)
    const status = getByRole('status')
    expect(status.textContent).toBe('')
    expect(status.getAttribute('aria-label')).toBe('Reading…')
  })
})
