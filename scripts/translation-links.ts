/** Locale-aware resolution and byte-preserving rewrites for bilingual Markdown links. */

import { existsSync, statSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import type { Nodes } from 'mdast'
import { parseMarkdown, visitMarkdown } from './markdown.ts'

/** Repository and source document used to resolve one relative link. */
export interface TranslationLinkContext {
  /** Absolute repository root. */
  repoRoot: string
  /** Repository-relative Markdown source path. */
  sourcePath: string
  /** Selected content plane; defaults to regular files in the working tree. */
  repositoryFileExists?: (repoPath: string) => boolean
}

/** One relative document link whose target uses the wrong locale sibling. */
export interface TranslationLinkLocaleViolation {
  sourcePath: string
  line: number
  url: string
  expectedUrl: string
}

/** Result of rewriting wrong-locale relative document links. */
export interface TranslationLinkRewriteResult {
  content: string
  rewritten: number
}

interface TranslationPairTarget {
  source: string
  zh: string
}

interface ResolvedTranslationLink {
  pair: TranslationPairTarget
  targetPath: string
  suffix: string
  expectedPath: string
  expectedUrl: string
  kind: ResolutionKind
  locale: 'en' | 'zh'
}

interface Replacement {
  start: number
  end: number
  value: string
}

interface DestinationRange {
  start: number
  end: number
}

interface AuthoredDestination extends DestinationRange {
  url: string
}

type LinkNode = Extract<Nodes, { type: 'link' | 'definition' }>
type ResolutionKind = 'exact' | 'extensionless' | 'directory-index'

function isExternalOrAbsolute(url: string): boolean {
  return url.startsWith('#')
    || url.startsWith('//')
    || url.startsWith('/')
    || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

/** Split a URL without normalizing its query or fragment suffix. */
export function splitTranslationLinkTarget(url: string): { path: string; suffix: string } {
  const boundary = url.search(/[?#]/)
  if (boundary === -1) return { path: url, suffix: '' }
  return { path: url.slice(0, boundary), suffix: url.slice(boundary) }
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function worktreeFileExists(repoRoot: string, repoPath: string): boolean {
  try {
    const path = resolve(repoRoot, repoPath)
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function repositoryFileExists(context: TranslationLinkContext, repoPath: string): boolean {
  return context.repositoryFileExists?.(repoPath) ?? worktreeFileExists(context.repoRoot, repoPath)
}

function repositoryRelativePath(path: string): string | undefined {
  const normalized = posix.normalize(path)
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) {
    return undefined
  }
  return normalized
}

function resolveRepositoryTarget(
  rawPath: string,
  context: TranslationLinkContext,
): { path: string; kind: ResolutionKind } | undefined {
  const decoded = decodePath(rawPath)
  const exact = repositoryRelativePath(posix.join(posix.dirname(context.sourcePath), decoded))
  if (exact === undefined) return undefined
  if (repositoryFileExists(context, exact)) return { path: exact, kind: 'exact' }
  const index = repositoryRelativePath(posix.join(exact, 'index.md'))
  if (decoded.endsWith('/') && index !== undefined && repositoryFileExists(context, index)) {
    return { path: index, kind: 'directory-index' }
  }
  if (posix.extname(decoded) === '') {
    const markdown = repositoryRelativePath(`${exact}.md`)
    if (markdown !== undefined && repositoryFileExists(context, markdown)) {
      return { path: markdown, kind: 'extensionless' }
    }
    if (index !== undefined && repositoryFileExists(context, index)) {
      return { path: index, kind: 'directory-index' }
    }
  }
  return undefined
}

function translationPairTarget(targetPath: string, context: TranslationLinkContext): TranslationPairTarget | undefined {
  const source = targetPath.endsWith('.zh.md')
    ? targetPath.replace(/\.zh\.md$/, '.md')
    : targetPath.endsWith('.md') ? targetPath : undefined
  if (source === undefined) return undefined
  const zh = source.replace(/\.md$/, '.zh.md')
  if (!repositoryFileExists(context, source) || !repositoryFileExists(context, zh)) return undefined
  return { source, zh }
}

function fallbackRelativePath(context: TranslationLinkContext, targetPath: string, rawPath: string): string {
  const target = posix.relative(posix.dirname(context.sourcePath), targetPath)
  const encoded = encodeURI(target)
  return rawPath.startsWith('./') && !encoded.startsWith('.') ? `./${encoded}` : encoded
}

function expectedLocalePath(
  rawPath: string,
  kind: ResolutionKind,
  locale: 'en' | 'zh',
  context: TranslationLinkContext,
  targetPath: string,
): string {
  if (kind === 'exact') {
    if (locale === 'zh' && rawPath.endsWith('.md') && !rawPath.endsWith('.zh.md')) {
      return rawPath.replace(/\.md$/, '.zh.md')
    }
    if (locale === 'en' && rawPath.endsWith('.zh.md')) return rawPath.replace(/\.zh\.md$/, '.md')
  }
  if (kind === 'extensionless') return `${rawPath}${locale === 'zh' ? '.zh.md' : '.md'}`
  if (kind === 'directory-index' && locale === 'zh') {
    return `${rawPath}${rawPath.endsWith('/') ? '' : '/'}index.zh.md`
  }
  return fallbackRelativePath(context, targetPath, rawPath)
}

function resolveTranslationLink(
  url: string,
  context: TranslationLinkContext,
  authoredUrl: string = url,
): ResolvedTranslationLink | undefined {
  if (isExternalOrAbsolute(url)) return undefined
  const { path } = splitTranslationLinkTarget(url)
  const authored = splitTranslationLinkTarget(authoredUrl)
  if (path === '') return undefined
  const resolved = resolveRepositoryTarget(path, context)
  if (resolved === undefined) return undefined
  const targetPath = resolved.path
  const pair = translationPairTarget(targetPath, context)
  if (pair === undefined) return undefined
  const locale = context.sourcePath.endsWith('.zh.md') ? 'zh' : 'en'
  const expectedPath = locale === 'zh' ? pair.zh : pair.source
  return {
    pair,
    targetPath,
    suffix: authored.suffix,
    expectedPath,
    expectedUrl: `${expectedLocalePath(authored.path, resolved.kind, locale, context, expectedPath)}${authored.suffix}`,
    kind: resolved.kind,
    locale,
  }
}

function hasExpectedLocale(resolved: ResolvedTranslationLink): boolean {
  if (resolved.targetPath !== resolved.expectedPath) return false
  return !(resolved.locale === 'en' && resolved.kind === 'extensionless')
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (/\s/.test(source[index] ?? '')) index += 1
  return index
}

function labelEnd(source: string): number {
  const first = source.indexOf('[')
  if (first === -1) return -1
  let depth = 0
  for (let index = first; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') index += 1
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function destinationRange(rawNode: string, type: LinkNode['type']): DestinationRange {
  const endOfLabel = labelEnd(rawNode)
  if (endOfLabel === -1) throw new Error(`translation-links: cannot locate label end in ${JSON.stringify(rawNode)}`)
  let start: number
  if (type === 'definition') {
    const colon = rawNode.indexOf(':', endOfLabel + 1)
    if (colon === -1) throw new Error(`translation-links: cannot locate definition separator in ${JSON.stringify(rawNode)}`)
    start = skipWhitespace(rawNode, colon + 1)
  } else {
    if (rawNode[endOfLabel + 1] !== '(') {
      throw new Error(`translation-links: cannot locate inline destination in ${JSON.stringify(rawNode)}`)
    }
    start = skipWhitespace(rawNode, endOfLabel + 2)
  }
  if (rawNode[start] === '<') {
    for (let index = start + 1; index < rawNode.length; index += 1) {
      if (rawNode[index] === '\\') index += 1
      else if (rawNode[index] === '>') return { start: start + 1, end: index }
    }
    throw new Error(`translation-links: cannot locate angle-bracket destination end in ${JSON.stringify(rawNode)}`)
  }
  let depth = 0
  for (let index = start; index < rawNode.length; index += 1) {
    const char = rawNode[index]
    if (char === '\\') index += 1
    else if (char === '(') depth += 1
    else if (char === ')') {
      if (depth === 0) return { start, end: index }
      depth -= 1
    } else if (/\s/.test(char ?? '') && depth === 0) {
      return { start, end: index }
    }
  }
  return { start, end: rawNode.length }
}

function authoredDestination(markdown: string, node: LinkNode): AuthoredDestination {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) {
    throw new Error(`translation-links: link ${JSON.stringify(node.url)} has no source offsets`)
  }
  const range = destinationRange(markdown.slice(start, end), node.type)
  const absolute = { start: start + range.start, end: start + range.end }
  return { ...absolute, url: markdown.slice(absolute.start, absolute.end) }
}

function replacementFor(destination: AuthoredDestination, value: string): Replacement {
  return { start: destination.start, end: destination.end, value }
}

function applyReplacements(markdown: string, replacements: Replacement[]): string {
  let output = markdown
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end)
  }
  return output
}

function visitDocumentLinkNodes(markdown: string, visitor: (node: LinkNode) => void): void {
  const tree = parseMarkdown(markdown)
  const linkDefinitions = new Set<string>()
  visitMarkdown(tree, (node) => {
    if (node.type === 'linkReference') linkDefinitions.add(node.identifier)
  })
  visitMarkdown(tree, (node) => {
    if (node.type === 'link' || (node.type === 'definition' && linkDefinitions.has(node.identifier))) {
      visitor(node)
    }
  })
}

/** Return one violation per wrong-locale link or link definition. */
export function translationLinkLocaleViolations(
  markdown: string,
  context: TranslationLinkContext,
  skipTargets: readonly string[] = [],
): TranslationLinkLocaleViolation[] {
  const skipped = new Set(skipTargets)
  const violations: TranslationLinkLocaleViolation[] = []
  visitDocumentLinkNodes(markdown, (node) => {
    if (skipped.has(node.url)) return
    const authored = authoredDestination(markdown, node)
    const resolved = resolveTranslationLink(node.url, context, authored.url)
    if (resolved === undefined || hasExpectedLocale(resolved)) return
    violations.push({
      sourcePath: context.sourcePath,
      line: node.position?.start.line ?? 0,
      url: authored.url,
      expectedUrl: resolved.expectedUrl,
    })
  })
  return violations
}

/** Rewrite wrong-locale document links without reserializing surrounding Markdown. */
export function rewriteTranslationLinkLocales(
  markdown: string,
  context: TranslationLinkContext,
  skipTargets: readonly string[] = [],
): TranslationLinkRewriteResult {
  const skipped = new Set(skipTargets)
  const replacements: Replacement[] = []
  visitDocumentLinkNodes(markdown, (node) => {
    if (skipped.has(node.url)) return
    const authored = authoredDestination(markdown, node)
    const resolved = resolveTranslationLink(node.url, context, authored.url)
    if (resolved === undefined || hasExpectedLocale(resolved)) return
    replacements.push(replacementFor(authored, resolved.expectedUrl))
  })
  return { content: applyReplacements(markdown, replacements), rewritten: replacements.length }
}

/** Normalize only paired-document locale paths while retaining every other byte and URL suffix. */
export function normalizeTranslationMarkdownLinks(
  markdown: string,
  context: TranslationLinkContext,
  skipTargets: readonly string[] = [],
): string {
  const skipped = new Set(skipTargets)
  const replacements: Replacement[] = []
  visitDocumentLinkNodes(markdown, (node) => {
    if (skipped.has(node.url)) return
    const authored = authoredDestination(markdown, node)
    const resolved = resolveTranslationLink(node.url, context, authored.url)
    if (resolved === undefined) return
    replacements.push(replacementFor(
      authored,
      `dsh-translation-target:${resolved.pair.source}${resolved.suffix}`,
    ))
  })
  return applyReplacements(markdown, replacements)
}

/** Semantic target used by the pair structure signature. */
export function semanticTranslationLinkTarget(url: string, context: TranslationLinkContext): string {
  const resolved = resolveTranslationLink(url, context)
  return resolved === undefined
    ? url
    : `dsh-translation-target:${resolved.pair.source}${resolved.suffix}`
}

/** Semantic target of one authored inline link or referenced definition. */
export function semanticTranslationLinkNodeTarget(
  node: LinkNode,
  markdown: string,
  context: TranslationLinkContext,
): string {
  const authored = authoredDestination(markdown, node)
  const resolved = resolveTranslationLink(node.url, context, authored.url)
  return resolved === undefined
    ? authored.url
    : `dsh-translation-target:${resolved.pair.source}${resolved.suffix}`
}
