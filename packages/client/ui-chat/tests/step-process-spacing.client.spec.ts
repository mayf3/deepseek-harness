/** CSS checks for the secondary process title's surrounding vertical rhythm. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/client/chat/${name}`, import.meta.url)), 'utf8')

describe('secondary process spacing', () => {
  it('keeps 16px around the title and 8px between expanded rows', () => {
    const flow = read('ChatView.module.css')
    expect(flow.match(/--dsh-chat-flow-gap:\s*16px/g)).toHaveLength(2)

    const process = read('StepProcessList.module.css')
    expect(process).toMatch(/\.title\[aria-expanded="true"\]\s*\{[^}]*padding-bottom:\s*16px/s)
    expect(process).toMatch(/\.body\s*\{[^}]*--dsh-chat-flow-gap:\s*8px/s)
  })
})
