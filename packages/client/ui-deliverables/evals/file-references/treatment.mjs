/** Frozen evaluation treatment registered through the ordinary system-prompt plugin. */
import { readFileSync } from 'node:fs'

export const name = 'file-reference-evaluation'
export const inject = ['systemPrompt']

export function apply(ctx, config) {
  ctx.systemPrompt.section({
    name: 'evaluation:file-references',
    order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES'),
    text: readFileSync(config.promptFile, 'utf8'),
    interpolate: false,
  })
}
