/**
 * Feedback stylesheet contract, asserted against the CSS text on disk for the
 * message controls and the dialog.
 *
 * A `--dsw-*` name the theme never declares fails silently, and for the
 * controls' sheet it failed loudly in the product: `border`, `background`, and
 * the primary button's fill and label each named a token that does not exist,
 * so every one of those declarations was invalid at computed-value time and
 * dropped. The note editor of the time shipped with no border and no surface,
 * and its Save button with neither fill nor readable label. Nothing downstream
 * reports this — the sheet parses, the classes attach, and the DOM snapshots
 * are unchanged.
 *
 * The dialog is the body-portaled Modal primitive, so nothing this package
 * renders enters the IconActions row's flex layout beyond the two 28px
 * buttons and the failure notice.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SHEETS = ['MessageFeedbackActions', 'FeedbackDialog'] as const
const sheets = Object.fromEntries(SHEETS.map(name => [name, readFileSync(
  fileURLToPath(new URL(`../src/client/${name}.module.css`, import.meta.url)),
  'utf8',
)])) as Record<(typeof SHEETS)[number], string>
const css = sheets.MessageFeedbackActions
// The theme package maps `./styles/*` to `./src/styles/*`, so the declarations
// stay on the source plane rather than needing a build. Every theme sheet, not
// just the platform tokens: font and scrollbar variables are declared in
// siblings, and a gate reading one file would call their names undeclared.
const tokens = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

/**
 * The declarations of one top-level rule, by selector.
 * @param selector - the class selector to read, including its leading dot.
 * @returns the rule's declaration text.
 */
function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`MessageFeedbackActions.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe.each(SHEETS)('%s theme styles', (name) => {
  const sheet = sheets[name]

  it('names only theme variables the token sheet defines', () => {
    // The regression that motivated this file. An undeclared custom property
    // has no fallback and does not inherit a usable value: the entire
    // declaration is thrown away, so the control renders as if the line had
    // never been written. Every theme-variable prefix the sheets actually use,
    // not just `--dsw-`: a `--dsh-` name reads as a plausible sibling and would
    // otherwise slip past into an invalid declaration.
    const named = [...sheet.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
    // Vacuity guard: the sheet has to actually name tokens, or the filter below
    // is satisfied by an empty list and this test proves nothing.
    expect(named.length).toBeGreaterThan(3)
    const undeclared = [...new Set(named)].filter(token => !tokens.includes(`  ${String(token)}:`))
    expect(undeclared).toEqual([])
  })

  it('never falls back to a literal colour', () => {
    // A token that resolves is never the problem; an undeclared one takes this
    // branch, and a literal here is a single colour for both themes.
    expect(sheet).not.toMatch(/var\(--dsw-[a-z0-9-]+\s*,\s*(?:#|rgb|rgba|hsl|hsla)/)
  })

  it('closes every block, so no rule is swallowed by the one above it', () => {
    // A missing `}` is not a parse error: every rule after it silently becomes
    // part of the block above, and the controls would paint unstyled.
    const bare = sheet.replace(/\/\*[\s\S]*?\*\//g, '')
    expect((bare.match(/\}/g) ?? []).length).toBe((bare.match(/\{/g) ?? []).length)
  })
})

describe('MessageFeedbackActions row styles', () => {
  it('slot-injected actions ride the content font-size axis like their host row', () => {
    // These buttons render inside ui-chat's MessageIconActions row; a fixed
    // 28px would leave them undersized (or overflowing) once the Settings
    // font size moves the row.
    expect(block('.action')).toMatch(/width:\s*calc\(28px \+ var\(--dsh-content-font-delta, 0px\)\)/)
    expect(block('.action')).toMatch(/height:\s*calc\(28px \+ var\(--dsh-content-font-delta, 0px\)\)/)
    expect(block('.action svg')).toMatch(/width:\s*calc\(15px \+ var\(--dsh-content-font-delta, 0px\)\)/)
  })
})
