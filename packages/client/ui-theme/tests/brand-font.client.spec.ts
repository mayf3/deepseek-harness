/** The brand font remains self-contained in the packaged Web application. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('offline brand font', () => {
  it('ships a local TTF with its redistribution license', () => {
    const css = readFileSync(new URL('../src/styles/brand-font.css', import.meta.url), 'utf8')
    const fontPath = /url\(\.\/([^)]*\.ttf)\)/.exec(css)?.[1]
    expect(fontPath).toBeDefined()
    const font = readFileSync(new URL(`../src/styles/${fontPath!}`, import.meta.url))
    expect(font.readUInt32BE(0)).toBe(0x00010000)
    expect(css).toContain('font-weight: 400')
    expect(css).toContain('font-style: normal')
    expect(css).not.toMatch(/url\(https?:/)
    const license = readFileSync(new URL('../src/styles/Montserrat-OFL.txt', import.meta.url), 'utf8')
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1')
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      files: string[]
      exports: Record<string, unknown>
    }
    expect(manifest.files).toContain('lib/styles')
    expect(manifest.exports['./brand-font.css']).toBe('./lib/styles/brand-font.css')
  })
})
