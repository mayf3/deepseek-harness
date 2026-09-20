// @vitest-environment jsdom
/** The two modality answers: what a tooltip reads, and what a focus ring reads. */
import { describe, expect, it } from 'vitest'
import { INPUT_MODALITY, INPUT_MODALITY_ATTRIBUTE, pointerModality } from '../src/input-modality.ts'

const press = (key: string): void => { window.dispatchEvent(new KeyboardEvent('keydown', { key })) }
const click = (): void => { window.dispatchEvent(new Event('pointerdown')) }
const published = (): string | null => document.documentElement.getAttribute(INPUT_MODALITY_ATTRIBUTE)

describe('input modality', () => {
  it('returns tooltips to the keyboard on any key', () => {
    click()
    expect(pointerModality()).toBe(true)
    for (const key of ['Shift', 'Escape', 'a', 'Enter']) {
      click()
      press(key)
      expect(pointerModality()).toBe(false)
    }
  })

  it('keeps a pointer focused control silent through keys that do not navigate', () => {
    click()
    expect(published()).toBe(INPUT_MODALITY.pointer)

    for (const key of ['Shift', 'Escape', 'a', 'Control', 'Meta', 'Enter', ' ']) press(key)
    expect(published()).toBe(INPUT_MODALITY.pointer)
  })

  it('returns the ring to the keyboard on focus navigation', () => {
    click()
    press('Tab')
    expect(published()).toBe(INPUT_MODALITY.keyboard)

    click()
    press('ArrowDown')
    expect(published()).toBe(INPUT_MODALITY.keyboard)
  })
})
