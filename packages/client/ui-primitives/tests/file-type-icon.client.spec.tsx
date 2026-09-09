// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FileTypeIcon, classifyFileType, type FileTypeKind } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

const KINDS: FileTypeKind[] = ['code', 'html', 'image', 'markdown', 'pdf', 'sheet', 'slides', 'document', 'other']

describe('classifyFileType', () => {
  it.each([
    ['src/render.tsx', 'code'],
    ['site/index.HTML', 'html'],
    ['README.md', 'markdown'],
    ['data/export.csv', 'sheet'],
    ['book.xlsx', 'sheet'],
    ['shots/hero.png', 'image'],
    ['report.pdf', 'pdf'],
    ['deck.pptx', 'slides'],
    ['C:\\work\\summary.docx', 'document'],
    ['notes.unknownext', 'other'],
    ['Makefile', 'other'],
    ['archive.tar/.hidden', 'other'],
  ] as [string, FileTypeKind][])('%s → %s', (path, kind) => {
    expect(classifyFileType(path)).toBe(kind)
  })
})

describe('FileTypeIcon', () => {
  it.each(KINDS)('%s draws the shared sheet in its own colour, aria-hidden', (kind) => {
    const { container } = render(<FileTypeIcon kind={kind} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('width')).toBe('28')
    expect(svg.querySelector('path')!.getAttribute('fill')).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('every kind carries a distinct mark', () => {
    const marks = KINDS.map((kind) => {
      const { container } = render(<FileTypeIcon kind={kind} />)
      const [, mark] = Array.from(container.querySelectorAll('path, rect'))
      return `${mark!.getAttribute('d') ?? ''}${mark!.getAttribute('y') ?? ''}`
    })
    expect(new Set(marks).size).toBe(KINDS.length)
  })

  it('folds a darker corner on the grey sheet and a translucent one elsewhere', () => {
    const grey = render(<FileTypeIcon kind="other" />).container.querySelectorAll('path')
    expect(grey[grey.length - 1]!.getAttribute('fill')).toBe('#A2A4A6')
    const blue = render(<FileTypeIcon kind="code" />).container.querySelectorAll('path')
    expect(blue[blue.length - 1]!.getAttribute('fill-opacity')).toBe('0.7')
  })

  it('size and className land on the svg', () => {
    const { container } = render(<FileTypeIcon kind="pdf" size={16} className="x" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    expect(svg.classList.contains('x')).toBe(true)
  })
})
