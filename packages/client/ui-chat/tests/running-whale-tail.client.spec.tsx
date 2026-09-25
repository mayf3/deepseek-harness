// @vitest-environment jsdom

import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunningWhaleTail } from '../src/client/chat/RunningWhaleTail.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function motionPreference(matches: boolean) {
  const media = Object.assign(new EventTarget(), {
    matches, media: '(prefers-reduced-motion: reduce)', onchange: null,
    addListener: vi.fn<MediaQueryList['addListener']>(),
    removeListener: vi.fn<MediaQueryList['removeListener']>(),
  })
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  return media
}

describe('RunningWhaleTail', () => {
  it('animates when the environment exposes no motion preference', () => {
    expect(typeof matchMedia).toBe('undefined')
    const view = render(<RunningWhaleTail />)
    expect(view.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelector('animate')).not.toBeNull()
  })

  it.each([false, true])('initializes with reduced motion set to %s', (reduced) => {
    motionPreference(reduced)
    const view = render(<RunningWhaleTail />)
    expect(view.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16')
    const animation = view.container.querySelector('animate')
    if (reduced) {
      expect(animation).toBeNull()
      return
    }
    expect(animation?.getAttribute('attributeName')).toBe('d')
    expect(animation?.getAttribute('begin')).toBe('0.3s')
    expect(animation?.getAttribute('dur')).toBe('3s')
    expect(animation?.getAttribute('repeatCount')).toBe('indefinite')
    const paths = animation!.getAttribute('values')!.split(';')
    const times = animation!.getAttribute('keyTimes')!.split(';').map(Number)
    expect(paths.length).toBeGreaterThan(1)
    expect(paths).toHaveLength(times.length)
    expect(paths[0]).toBe(view.container.querySelector('path')?.getAttribute('d'))
    expect(paths.at(-1)).toBe(paths[0])
    expect(times[0]).toBe(0)
    expect(times.at(-1)).toBe(1)
    expect(times.slice(1).every((time, i) => time > times[i]!)).toBe(true)
  })

  it('restores the static pose and restarts the SVG timeline when motion is re-enabled', () => {
    const media = motionPreference(false)
    const view = render(<RunningWhaleTail />)
    const original = view.container.querySelector('svg')
    const restingPath = original?.querySelector('path')?.getAttribute('d')
    act(() => { media.matches = true; media.dispatchEvent(new Event('change')) })
    const still = view.container.querySelector('svg')
    expect(still).not.toBe(original)
    expect(still?.querySelector('animate')).toBeNull()
    expect(still?.querySelector('path')?.getAttribute('d')).toBe(restingPath)
    act(() => { media.matches = false; media.dispatchEvent(new Event('change')) })
    expect(view.container.querySelector('svg')).not.toBe(still)
    expect(view.container.querySelector('animate')?.getAttribute('begin')).toBe('0.3s')
  })

  it('removes each preference listener across StrictMode setup and unmount', () => {
    const media = motionPreference(false)
    const add = vi.spyOn(media, 'addEventListener')
    const remove = vi.spyOn(media, 'removeEventListener')
    const view = render(<StrictMode><RunningWhaleTail /></StrictMode>)
    expect(add).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(remove).toHaveBeenCalledTimes(2)
    expect(remove.mock.calls).toEqual(add.mock.calls)
  })
})
