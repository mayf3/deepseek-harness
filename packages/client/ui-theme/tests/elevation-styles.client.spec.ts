/**
 * Elevation stylesheet contract, asserted against the CSS text on disk:
 * gradient-shadow-text.css composes the elevation tokens from a rebindable
 * 0.5px hairline stroke plus soft layers, and no package rule pairs an
 * lv/elevation box-shadow with a neutral-border-token border — elevated
 * surfaces draw their neutral stroke inside the elevation shadow (border: 0),
 * never as a layout-consuming border beside it. State-colored borders (for
 * example the warn approval panels) stay real borders and are out of scope.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packageStylesheets, parseRules } from './stylesheet-scan.ts'

/** Stroke-color indirection components may rebind per surface or state. */
const STROKE_COLOR = '--dsw-elevation-stroke-color'
/** Shadow-token references that mark a rule as an elevated surface. */
const ELEVATED_SHADOW = /--dsw-(?:shadow-lv|elevation-)/
/** Neutral border tokens; the state palette (--dsw-alias-state-*) stays allowed. */
const NEUTRAL_BORDER = /--dsw-alias-border-/

const sheetCss = readFileSync(
  fileURLToPath(new URL('../src/styles/gradient-shadow-text.css', import.meta.url)), 'utf8')

describe('elevation tokens', () => {
  const declarations = new Map(parseRules(sheetCss)
    .filter(rule => rule.selectors.includes('body'))
    .flatMap(rule => rule.declarations))

  it('draws the hairline stroke at 0.5px through the rebindable color indirection', () => {
    expect(declarations.get(STROKE_COLOR)).toBe('var(--dsw-alias-border-l4)')
    expect(declarations.get('--dsw-elevation-stroke')).toBe(`0 0 0 0.5px var(${STROKE_COLOR})`)
  })

  it('layers panel and prominent on top of the stroke', () => {
    for (const name of ['--dsw-elevation-panel', '--dsw-elevation-prominent', '--dsw-elevation-soft']) {
      expect(declarations.get(name), name).toMatch(/^var\(--dsw-elevation-stroke\), 0 /)
    }
  })
})

describe('elevated surfaces carry no neutral border', () => {
  it('never pairs an lv/elevation shadow with a neutral border token under packages/', () => {
    // A 1px border beside the elevation stroke double-draws the outline and
    // shifts layout by the border width; the hairline belongs to the shadow.
    const paired: string[] = []
    for (const file of packageStylesheets()) {
      for (const rule of parseRules(readFileSync(file, 'utf8'))) {
        const elevated = rule.declarations
          .some(([property, value]) => property === 'box-shadow' && ELEVATED_SHADOW.test(value))
        if (!elevated) continue
        const neutralBorder = rule.declarations.some(([property, value]) =>
          property.startsWith('border') && !property.startsWith('border-radius') && NEUTRAL_BORDER.test(value))
        if (neutralBorder) paired.push(`${file} ${rule.selectors.join(', ')}`)
      }
    }
    expect(paired).toEqual([])
  })
})

describe('neutral solid borders are hairlines', () => {
  /** Border properties that carry a width in their shorthand. */
  const BORDER_EDGE = /^border(?:-top|-bottom|-left|-right)?$/
  /**
   * Spinner ring tracks, keyed `<basename> <selector>`: the border is the
   * drawn graphic (a rotating ring), not an outline, so it keeps its width.
   */
  const RING_TRACKS = new Set([
    'boot-page.module.css .spinner',
    'TrajectoryTable.module.css .historyLoadingSpinner',
  ])

  it('draws every solid neutral-token border at 0.5px under packages/', () => {
    // Buttons, inputs, cards, and separators share the hairline weight;
    // dashed affordances and state-colored borders are out of scope.
    const wide: string[] = []
    for (const file of packageStylesheets()) {
      const base = file.slice(file.lastIndexOf('/') + 1)
      for (const rule of parseRules(readFileSync(file, 'utf8'))) {
        for (const [property, value] of rule.declarations) {
          if (!BORDER_EDGE.test(property)) continue
          if (!value.includes('solid') || !NEUTRAL_BORDER.test(value)) continue
          if (value.startsWith('0.5px ')) continue
          if (rule.selectors.some(selector => RING_TRACKS.has(`${base} ${selector}`))) continue
          wide.push(`${file} ${rule.selectors.join(', ')} ${property}: ${value}`)
        }
      }
    }
    expect(wide).toEqual([])
  })

  it('draws every filled divider line at 0.5px under packages/', () => {
    // A separator drawn as a filled box — 1px tall or wide with a border-token
    // background (menu separators, the conversation header seam, markdown hr,
    // vertical rails) — is the same hairline as a border. Visually-hidden 1px
    // clip boxes carry no border-token background and stay exempt.
    const wide: string[] = []
    for (const file of packageStylesheets()) {
      for (const rule of parseRules(readFileSync(file, 'utf8'))) {
        const paintsLine = rule.declarations.some(([property, value]) =>
          (property === 'background' || property === 'background-color') && NEUTRAL_BORDER.test(value))
        if (!paintsLine) continue
        for (const [property, value] of rule.declarations) {
          if ((property === 'height' || property === 'width') && value === '1px') {
            wide.push(`${file} ${rule.selectors.join(', ')} ${property}: ${value}`)
          }
        }
      }
    }
    expect(wide).toEqual([])
  })
})
