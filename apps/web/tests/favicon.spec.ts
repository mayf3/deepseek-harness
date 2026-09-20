// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { installFavicon } from '../src/favicon.ts'

const originalHead = document.head.innerHTML

afterEach(() => {
  document.head.innerHTML = originalHead
  document.documentElement.style.removeProperty('color-scheme')
  vi.unstubAllGlobals()
})

it.each([false, true])('selects fixed-color tab icons on boot and system changes (dark=%s)', (initialDark) => {
  const link = document.createElement('link')
  link.rel = 'icon'
  link.href = '/favicon.svg'
  document.head.append(link)
  let dark = initialDark
  let onChange = (): void => { throw new Error('missing scheme listener') }
  const matchMedia = vi.fn(() => ({
    get matches() { return dark },
    addEventListener: (event: string, listener: () => void) => {
      expect(event).toBe('change')
      onChange = listener
    },
  }))
  vi.stubGlobal('matchMedia', matchMedia)
  const readIcon = (): string => decodeURIComponent(link.href.slice('data:image/svg+xml,'.length))
  const expectFill = (fill: string): void => {
    expect(link.href).toMatch(/^data:image\/svg\+xml,/)
    const svg = new DOMParser().parseFromString(readIcon(), 'image/svg+xml')
    expect(svg.querySelector('parsererror')).toBeNull()
    expect(svg.querySelector('style')).toBeNull()
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe(fill)
    expect(svg.documentElement.getAttribute('viewBox')).toBe('0 0 50 50')
  }

  document.documentElement.style.colorScheme = initialDark ? 'light' : 'dark'
  installFavicon()
  expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')
  expectFill(initialDark ? '#fff' : '#000')
  const initial = link.href
  dark = !initialDark
  onChange()
  expectFill(initialDark ? '#000' : '#fff')
  expect(link.href).not.toBe(initial)
  dark = initialDark
  onChange()
  expect(link.href).toBe(initial)
})

it('requires the document favicon link', () => {
  document.querySelector('link[rel="icon"]')?.remove()
  expect(installFavicon).toThrow('web app: missing favicon link')
})
