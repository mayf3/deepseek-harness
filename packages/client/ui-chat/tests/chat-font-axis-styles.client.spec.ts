/**
 * The chat flow's font-size-axis adoption as CSS text. jsdom has no layout,
 * so these read the declarations that make think text, compaction rows, the
 * message clock, and the icon-action buttons follow the Settings font-size
 * preference through --dsh-content-font-size / --dsh-content-font-delta.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/client/chat/${name}`, import.meta.url)), 'utf8')

function declarationsFrom(source: string, selector: string): string[] {
  const declarationText = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rule = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('chat flow font-size axis', () => {
  it('think text reads the secondary tier (one step under the body size)', () => {
    const css = read('ReasoningRow.module.css')
    for (const selector of ['.summary', '.thinkBody']) {
      expect(declarationsFrom(css, selector)).toEqual(expect.arrayContaining([
        'font-size: var(--dsh-content-font-size-secondary, 13px)',
        'line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      ]))
    }
  })

  it('command and context summaries read the secondary tier on the shared row line', () => {
    expect(declarationsFrom(read('GenericCommandCard.module.css'), '.summary')).toEqual(expect.arrayContaining([
      'font-size: var(--dsh-content-font-size-secondary, 13px)',
      'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
    ]))
    const context = read('ContextInjectionRow.module.css')
    for (const selector of ['.source', '.summary']) {
      expect(declarationsFrom(context, selector)).toEqual(expect.arrayContaining([
        'font-size: var(--dsh-content-font-size-secondary, 13px)',
        'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
      ]))
    }
  })

  it('the message clock and action glyphs scale with the text they serve', () => {
    const actions = read('MessageIconActions.module.css')
    expect(declarationsFrom(actions, '.timeStart')).toEqual(expect.arrayContaining([
      'font-size: var(--dsh-content-font-size, 14px)',
    ]))
    // The assistant tail's meta line (the whole-line usage trigger) sits one
    // step under the body size; the user row's clock keeps the body size.
    expect(declarationsFrom(actions, '.timeEnd')).toEqual(expect.arrayContaining([
      'font-size: var(--dsh-content-font-size-secondary, 13px)',
    ]))
    expect(declarationsFrom(actions, '.action svg')).toEqual(expect.arrayContaining([
      'width: calc(15px + var(--dsh-content-font-delta, 0px))',
      'height: calc(15px + var(--dsh-content-font-delta, 0px))',
    ]))
  })

  it('compaction rows follow the axis like the disclosure rows they mirror', () => {
    const css = read('MessageItem.module.css')
    for (const selector of ['.compactionTitle', '.compactionSummary', '.compactionBody']) {
      expect(declarationsFrom(css, selector)).toEqual(expect.arrayContaining([
        'font-size: var(--dsh-content-font-size-secondary, 13px)',
        'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
      ]))
    }
    expect(declarationsFrom(css, '.compactionLeading svg')).toEqual(expect.arrayContaining([
      'width: calc(14px + var(--dsh-content-font-delta, 0px))',
      'height: calc(14px + var(--dsh-content-font-delta, 0px))',
    ]))
  })

  it('expanded bodies indent by 22px + delta so content stays under the shifted title start', () => {
    // The DisclosureRow title starts at leading (16 + delta) + gap 6; a fixed
    // 22px indent would misalign at every non-default size.
    const indent = 'calc(22px + var(--dsh-content-font-delta, 0px))'
    expect(declarationsFrom(read('ReasoningRow.module.css'), '.thinkBody'))
      .toEqual(expect.arrayContaining([`padding: 4px 0 4px ${indent}`]))
    expect(declarationsFrom(read('MessageItem.module.css'), '.compactionBody'))
      .toEqual(expect.arrayContaining([`padding: 4px 0 4px ${indent}`]))
    expect(declarationsFrom(read('ContextInjectionRow.module.css'), '.body'))
      .toEqual(expect.arrayContaining([`margin: 4px 0 0 ${indent}`]))
  })

  it('the usage-details trigger reads the secondary tier like its clock label', () => {
    const css = read('TurnUsagePanel.module.css')
    expect(declarationsFrom(css, '.trigger')).toEqual(expect.arrayContaining([
      'font-size: var(--dsh-content-font-size-secondary, 13px)',
      'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
    ]))
  })

  it('the whole-line trigger ellipsizes instead of widening the chat column', () => {
    // The one-line meta cluster stays nowrap; min-width 0 lets the flex item
    // shrink with the column and the hidden overflow trims to an ellipsis.
    const css = read('TurnUsagePanel.module.css')
    expect(declarationsFrom(css, '.trigger')).toEqual(expect.arrayContaining([
      'min-width: 0',
      'white-space: nowrap',
      'overflow: hidden',
      'text-overflow: ellipsis',
    ]))
    expect(declarationsFrom(css, '.root')).toEqual(expect.arrayContaining(['min-width: 0']))
  })

  it('the clickable and plain meta lines keep identical inset and separator spacing', () => {
    const panel = read('TurnUsagePanel.module.css')
    const actions = read('MessageIconActions.module.css')
    expect(declarationsFrom(panel, '.dot')).toEqual(['margin: 0 5px'])
    expect(declarationsFrom(actions, '.runTimeDot')).toEqual(['margin: 0 5px'])
    expect(declarationsFrom(panel, '.root')).toEqual(expect.arrayContaining(['margin-left: 12px']))
    expect(declarationsFrom(actions, '.timeEnd')).toEqual(expect.arrayContaining(['padding-left: 12px']))
  })

  it('non-latest turn tails hide the whole actions row until hover or focus', () => {
    // TurnTailNodeView tags its root data-actions-reveal='hover' for every
    // turn but the latest; the gate lives under @media (hover: hover) so
    // no-hover devices keep the row visible. 'always' has no rule at all —
    // absence, not an override, keeps the latest turn's row shown.
    const css = read('MessageIconActions.module.css')
    expect(declarationsFrom(css, "[data-actions-reveal='hover'] .actions"))
      .toEqual(expect.arrayContaining(['opacity: 0']))
    expect(css).toMatch(
      /\[data-actions-reveal='hover'\]:hover \.actions,\s*\[data-actions-reveal='hover'\]:focus-within \.actions \{\s*opacity: 1/,
    )
    expect(css).not.toContain("[data-actions-reveal='always']")
  })

  it('the interrupted-turn tag stays fixed like the dense token variants', () => {
    // 11px would fall to an illegible 9px at the 12px floor; the tag is
    // exempt from the axis the same way small/code tokens are.
    expect(declarationsFrom(read('AssistantMarkdown.module.css'), '.stopped')).toEqual(expect.arrayContaining([
      'font-size: 11px',
      'line-height: 18px',
    ]))
  })
})
