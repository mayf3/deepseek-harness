/** Native code-group markup remains isolated when local search copies a section. */

import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createMarkdownRenderer } from 'vitepress'
import { expect, it } from 'vitest'
import { isolateCodeGroupRadios } from '../.vitepress/code-groups.ts'

it('keeps the page selection when a search excerpt selects the same named radio', async () => {
  const md = await createMarkdownRenderer(import.meta.dirname, { config: isolateCodeGroupRadios })
  const html = md.render('::: code-group\n\n```sh [Linux/macOS]\n. .venv/bin/activate\n```\n\n```powershell [Windows PowerShell]\n.venv\\Scripts\\Activate.ps1\n```\n\n:::\n')
  const dom = new JSDOM(`<main>${html}</main><aside>${html}</aside>`)
  try {
    const { document } = dom.window
    const pageRadios = document.querySelectorAll<HTMLInputElement>('main input')
    const excerptRadio = document.querySelector<HTMLInputElement>('aside input')
    assert(pageRadios[0] && pageRadios[1] && excerptRadio)
    pageRadios[1].checked = true
    excerptRadio.checked = true

    expect(pageRadios[0].checked).toBe(false)
    expect(pageRadios[1].checked).toBe(true)
    expect(excerptRadio.checked).toBe(true)
    expect(pageRadios[0].name).toBe(excerptRadio.name)
    expect(pageRadios[0].form).not.toBeNull()
    expect(pageRadios[0].form).not.toBe(excerptRadio.form)
    expect(document.querySelector('main .tabs')?.hasAttribute('@submit.prevent')).toBe(true)
    expect([...document.querySelectorAll('main code')].map(code => code.textContent)).toEqual([
      '. .venv/bin/activate', '.venv\\Scripts\\Activate.ps1',
    ])
    expect(document.querySelectorAll('main .blocks > .active')).toHaveLength(1)
  } finally {
    dom.window.close()
  }
})
