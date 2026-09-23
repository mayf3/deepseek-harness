/** Browser geometry for one moving mask over text beside retained row icons. */
import type { Locator } from 'playwright'
import { expect } from 'vitest'

/**
 * Check glyph alignment and scroll overflow across a running row's shared sweep.
 * @param row - visible row containing exactly one active shimmer.
 * @returns after restoring the row's animation playback.
 */
export async function expectSharedShimmer(row: Locator): Promise<void> {
  const shimmer = row.locator('[data-shimmer="true"]')
  expect(await shimmer.count()).toBe(1)
  const frames = await shimmer.evaluate((root) => {
    const base = root.firstElementChild!
    const decoration = root.querySelector(':scope > [inert]')!
    const mask = decoration.firstElementChild!
    const highlight = mask.firstElementChild!
    const animations = root.getAnimations({ subtree: true })
      .filter(animation => animation instanceof CSSAnimation && animation.animationName.includes('dsh-row-shimmer-'))
    const original = animations.map(animation => ({ animation, time: animation.currentTime, state: animation.playState }))
    try {
      return [400, 800, 1200, 1301, 1799, 1801].map((time) => {
        for (const animation of animations) {
          animation.pause()
          animation.currentTime = time
        }
        const originals = [...base.querySelectorAll('svg, span, button')]
        const copies = [...highlight.querySelectorAll('svg, span, button')]
        return {
          animations: animations.length,
          mask: getComputedStyle(mask).maskImage,
          hidden: decoration.getAttribute('aria-hidden'),
          maskLeft: mask.getBoundingClientRect().left,
          width: root.getBoundingClientRect().width,
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          icons: base.querySelectorAll('svg').length,
          copyCount: copies.length,
          baseCount: originals.length,
          glyphOffsets: originals.map((element, index) => {
            const a = element.getBoundingClientRect()
            const b = copies[index]!.getBoundingClientRect()
            return [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height]
          }).flat(),
        }
      })
    } finally {
      for (const { animation, time, state } of original) {
        animation.currentTime = time
        if (state === 'running') animation.play()
      }
    }
  })
  for (const frame of frames) {
    expect(frame.animations).toBe(2)
    expect(frame.mask).toContain('linear-gradient')
    expect(frame.hidden).toBe('true')
    expect(frame.width).toBeGreaterThan(0)
    expect(frame.scrollWidth).toBe(frame.clientWidth)
    expect(frame.icons).toBe(0)
    expect(frame.copyCount).toBe(frame.baseCount)
    expect(frame.glyphOffsets.every(offset => Math.abs(offset) < 0.1)).toBe(true)
  }
  expect(frames[0]!.maskLeft).toBeLessThan(frames[1]!.maskLeft)
  expect(frames[1]!.maskLeft).toBeLessThan(frames[2]!.maskLeft)
}
