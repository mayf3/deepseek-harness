// @vitest-environment jsdom
/** The document modality that decides whether focus may reveal itself. */
import { describe, expect, it } from 'vitest'
import { INPUT_MODALITY, INPUT_MODALITY_ATTRIBUTE, pointerModality } from '../src/input-modality.ts'

const press = (key: string): void => { window.dispatchEvent(new KeyboardEvent('keydown', { key })) }
const click = (): void => { window.dispatchEvent(new Event('pointerdown')) }

describe('input modality', () => {
  it('keeps a pointer focused control silent through keys that do not navigate', () => {
    click()
    expect(pointerModality()).toBe(true)
    expect(document.documentElement.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe(INPUT_MODALITY.pointer)

    for (const key of ['Shift', 'Escape', 'a', 'Control', 'Meta', 'Enter', ' ']) press(key)
    expect(pointerModality()).toBe(true)
    expect(document.documentElement.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe(INPUT_MODALITY.pointer)
  })

  it('returns to the keyboard modality on focus navigation', () => {
    click()
    press('Tab')
    expect(pointerModality()).toBe(false)
    expect(document.documentElement.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe(INPUT_MODALITY.keyboard)

    click()
    press('ArrowDown')
    expect(pointerModality()).toBe(false)
  })
})
