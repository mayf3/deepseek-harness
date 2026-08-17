/**
 * Gate for the invariant `FALLBACK_LOCALE` rests on: every shipped dictionary
 * declares the same keys in `zh` and `en`.
 *
 * The locale runtime resolves a key through the active locale, then through
 * the single fallback locale (`en`), then surfaces the key itself. With
 * symmetric dictionaries that middle step always resolves, so one constant can
 * serve as both the opening locale and the dictionary fallback. A key added to
 * only one side breaks that: a reader of the other language sees a bare key
 * such as `list.aria` instead of text. This gate fails on the asymmetry rather
 * than waiting for the bare key to reach a UI.
 */

import type { Dirent } from 'node:fs'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Every `locales*.ts` module under a client package's `src/`. */
function dictionaryModules(): string[] {
  const files: string[] = []
  for (const group of ['client', 'extensions']) {
    const groupRoot = resolve(root, 'packages', group)
    let packages: string[]
    try {
      packages = readdirSync(groupRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      continue
    }
    for (const pkg of packages) {
      const srcRoot = resolve(groupRoot, pkg, 'src')
      walk(srcRoot, files)
    }
  }
  return files.sort()
}

function walk(dir: string, out: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      if (/^locales?(\.[\w-]+)?\.ts$/.test(entry.name) || dir.endsWith('/locales')) out.push(full)
    }
  }
}

/**
 * Keys of every top-level `export const <zh|en>...= { ... }` object literal,
 * read from the AST so the gate never executes package code.
 * @param file - absolute path of the dictionary module.
 * @returns exported dictionary name mapped to its declared keys.
 */
function exportedDictionaries(file: string): Map<string, string[]> {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true)
  const found = new Map<string, string[]>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const exported = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true
    if (!exported) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue
      const initializer = unwrap(decl.initializer)
      if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) continue
      const keys: string[] = []
      for (const prop of initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) keys.push(prop.name.text)
      }
      found.set(decl.name.text, keys.sort())
    }
  }
  return found
}

/** Look through `satisfies`/`as`/parenthesized wrappers to the literal. */
function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node
  while (
    current !== undefined
    && (ts.isSatisfiesExpression(current) || ts.isAsExpression(current) || ts.isParenthesizedExpression(current))
  ) {
    current = current.expression
  }
  return current
}

/** Pair a `zh` export with the `en` export covering the same namespace. */
function counterpart(name: string): string | undefined {
  if (name === 'zh') return 'en'
  if (name.startsWith('zh') && name.length > 2) return `en${name.slice(2)}`
  if (name.endsWith('Zh')) return `${name.slice(0, -2)}En`
  return undefined
}

describe('shipped locale dictionaries', () => {
  it('declares the same keys in zh and en, so the single fallback locale always resolves', () => {
    const modules = dictionaryModules()
    // Guard the discovery itself: an empty sweep would pass every assertion
    // below while checking nothing.
    expect(modules.length).toBeGreaterThan(20)

    const mismatches: string[] = []
    let comparedPairs = 0
    for (const file of modules) {
      const dicts = exportedDictionaries(file)
      for (const [name, zhKeys] of dicts) {
        const enName = counterpart(name)
        if (enName === undefined) continue
        const enKeys = dicts.get(enName)
        if (enKeys === undefined) continue
        comparedPairs++
        const rel = file.slice(root.length)
        const zhOnly = zhKeys.filter(key => !enKeys.includes(key))
        const enOnly = enKeys.filter(key => !zhKeys.includes(key))
        if (zhOnly.length > 0) mismatches.push(`${rel} ${name} has keys absent from ${enName}: ${zhOnly.join(', ')}`)
        if (enOnly.length > 0) mismatches.push(`${rel} ${enName} has keys absent from ${name}: ${enOnly.join(', ')}`)
      }
    }

    expect(comparedPairs).toBeGreaterThan(20)
    expect(mismatches).toEqual([])
  })
})
