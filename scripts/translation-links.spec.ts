/** Regression coverage for locale-aware bilingual Markdown links. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeTranslationMarkdownLinks,
  rewriteTranslationLinkLocales,
  translationLinkLocaleViolations,
} from './translation-links.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeFixtureSafely(root)
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-translation-links-'))
  roots.push(root)
  mkdirSync(join(root, 'docs/section'), { recursive: true })
  writeFileSync(join(root, 'docs/guide.md'), '# Guide\n')
  writeFileSync(join(root, 'docs/guide.zh.md'), '# 指南\n')
  writeFileSync(join(root, 'docs/reference.md'), '# Overview\n')
  writeFileSync(join(root, 'docs/reference.zh.md'), '# 概览\n')
  writeFileSync(join(root, 'docs/unpaired.md'), '# Only\n')
  writeFileSync(join(root, 'docs/section/index.md'), '# Section\n')
  writeFileSync(join(root, 'docs/section/index.zh.md'), '# 章节\n')
  return root
}

describe('translation link locale validation', () => {
  it('rejects a Chinese link to the English sibling with an exact diagnostic', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '# 指南\n\n正文。\n\n[概览](reference.md?view=full#overview)\n',
      { repoRoot: root, sourcePath: 'docs/guide.zh.md' },
    )).toEqual([{
      sourcePath: 'docs/guide.zh.md',
      line: 5,
      url: 'reference.md?view=full#overview',
      expectedUrl: 'reference.zh.md?view=full#overview',
    }])
  })

  it('accepts the target-locale sibling and an unpaired target', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '[paired](reference.zh.md) [unpaired](unpaired.md)\n',
      { repoRoot: root, sourcePath: 'docs/guide.zh.md' },
    )).toEqual([])
  })

  it('requires English sources to use the English sibling', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '[Reference](reference.zh.md)\n',
      { repoRoot: root, sourcePath: 'docs/guide.md' },
    )[0]).toMatchObject({
      url: 'reference.zh.md',
      expectedUrl: 'reference.md',
    })
  })

  it('normalizes an English extensionless file alias but retains a directory-index alias', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '[Reference](reference)\n',
      { repoRoot: root, sourcePath: 'docs/guide.md' },
    )[0]).toMatchObject({ expectedUrl: 'reference.md' })
    expect(rewriteTranslationLinkLocales(
      '[Reference](reference)\n',
      { repoRoot: root, sourcePath: 'docs/guide.md' },
    ).content).toBe('[Reference](reference.md)\n')
    expect(translationLinkLocaleViolations(
      '[Section](section/)\n',
      { repoRoot: root, sourcePath: 'docs/guide.md' },
    )).toEqual([])
  })

  it('exempts the language switcher target explicitly', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '[English](guide.md) | 中文\n',
      { repoRoot: root, sourcePath: 'docs/guide.zh.md' },
      ['guide.md'],
    )).toEqual([])
  })

  it('resolves a directory alias to its paired index page', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '[章节](section/)\n',
      { repoRoot: root, sourcePath: 'docs/guide.zh.md' },
    )[0]).toMatchObject({ expectedUrl: 'section/index.zh.md' })
    expect(normalizeTranslationMarkdownLinks(
      '[Section](section/)\n',
      { repoRoot: root, sourcePath: 'docs/guide.md' },
    )).toBe(normalizeTranslationMarkdownLinks(
      '[Section](section/index.zh.md)\n',
      { repoRoot: root, sourcePath: 'docs/guide.zh.md' },
    ))
  })

  it('uses the selected repository content plane for sibling discovery', () => {
    const root = fixture()
    const staged = new Set(['docs/reference.md', 'docs/reference.zh.md'])
    expect(translationLinkLocaleViolations(
      '[概览](reference.md)\n',
      {
        repoRoot: root,
        sourcePath: 'docs/guide.zh.md',
        repositoryFileExists: path => staged.has(path),
      },
    )).toHaveLength(1)
    staged.delete('docs/reference.zh.md')
    expect(translationLinkLocaleViolations(
      '[概览](reference.md)\n',
      {
        repoRoot: root,
        sourcePath: 'docs/guide.zh.md',
        repositoryFileExists: path => staged.has(path),
      },
    )).toEqual([])
  })
})

describe('translation link rewriting and normalization', () => {
  it('rewrites only the destination while preserving the suffix and title', () => {
    const root = fixture()
    const input = '[概览](reference.md?view=full&amp;mode=all#overview "reference.md title")\n'
    expect(rewriteTranslationLinkLocales(
      input,
      { repoRoot: root, sourcePath: 'docs/guide.zh.md' },
    )).toEqual({
      content: '[概览](reference.zh.md?view=full&amp;mode=all#overview "reference.md title")\n',
      rewritten: 1,
    })
  })

  it('rewrites link definitions without changing their labels', () => {
    const root = fixture()
    expect(rewriteTranslationLinkLocales(
      '[概览][ref]\n\n[ref]: <reference.md#overview> "title"\n',
      { repoRoot: root, sourcePath: 'docs/guide.zh.md' },
    ).content).toBe('[概览][ref]\n\n[ref]: <reference.zh.md#overview> "title"\n')
  })

  it('does not treat an image-only definition as a document link', () => {
    const root = fixture()
    const input = '![preview][asset]\n\n[asset]: reference.zh.md#overview\n'
    expect(translationLinkLocaleViolations(
      input,
      { repoRoot: root, sourcePath: 'docs/guide.md' },
    )).toEqual([])
    expect(rewriteTranslationLinkLocales(
      input,
      { repoRoot: root, sourcePath: 'docs/guide.md' },
    )).toEqual({ content: input, rewritten: 0 })
    expect(normalizeTranslationMarkdownLinks(
      input,
      { repoRoot: root, sourcePath: 'docs/guide.md' },
    )).toBe(input)
  })

  it('normalizes only paired locale paths and retains other bytes', () => {
    const root = fixture()
    const english = '[Reference](reference.md#overview) [Only](unpaired.md)\n'
    const chinese = '[Reference](reference.zh.md#overview) [Only](unpaired.md)\n'
    expect(normalizeTranslationMarkdownLinks(
      english,
      { repoRoot: root, sourcePath: 'docs/guide.md' },
    )).toBe(normalizeTranslationMarkdownLinks(
      chinese,
      { repoRoot: root, sourcePath: 'docs/guide.zh.md' },
    ))
  })

  it('retains authored query bytes during normalization', () => {
    const root = fixture()
    const escaped = '[Reference](reference.md?x=1&amp;y=2#overview)\n'
    const literal = '[Reference](reference.zh.md?x=1&y=2#overview)\n'
    expect(normalizeTranslationMarkdownLinks(
      escaped,
      { repoRoot: root, sourcePath: 'docs/guide.md' },
    )).not.toBe(normalizeTranslationMarkdownLinks(
      literal,
      { repoRoot: root, sourcePath: 'docs/guide.zh.md' },
    ))
  })
})
