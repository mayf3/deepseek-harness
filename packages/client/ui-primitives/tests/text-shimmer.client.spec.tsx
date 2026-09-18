// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TextShimmer } from '../src/TextShimmer.tsx'

describe('TextShimmer', () => {
  it('keeps the settled text color while a lighter band moves across it', () => {
    const view = render(<TextShimmer>Thinking</TextShimmer>)
    const shimmer = view.getByText('Thinking')
    expect(shimmer.style.getPropertyValue('--dsh-text-shimmer-duration')).toBe('1.5s')
    expect(shimmer.style.getPropertyValue('--dsh-text-shimmer-spread')).toBe('64px')
    expect(shimmer.style.getPropertyValue('--dsh-text-shimmer-base-color')).toBe('currentColor')
    expect(shimmer.style.getPropertyValue('--dsh-text-shimmer-color')).toBe('color-mix(in oklab, currentColor 50%, transparent)')
  })

  it('derives the band width and exposes configurable animation colors', () => {
    const view = render(
      <TextShimmer as="strong" duration={3} spread={4} baseColor="gray" shimmerColor="white">
        Working
      </TextShimmer>,
    )
    const shimmer = view.getByText('Working')
    expect(shimmer.tagName).toBe('STRONG')
    expect(shimmer.getAttribute('data-text-shimmer')).toBe('')
    expect(shimmer.style.getPropertyValue('--dsh-text-shimmer-duration')).toBe('3s')
    expect(shimmer.style.getPropertyValue('--dsh-text-shimmer-spread')).toBe('28px')
    expect(shimmer.style.getPropertyValue('--dsh-text-shimmer-base-color')).toBe('gray')
    expect(shimmer.style.getPropertyValue('--dsh-text-shimmer-color')).toBe('white')
  })
})
