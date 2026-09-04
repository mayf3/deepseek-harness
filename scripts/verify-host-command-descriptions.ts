/**
 * Keep first-party Host command descriptions aligned with the Client's
 * English locale dictionary and localization allowlist.
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const MINIMUM_HOST_SOURCES = 1_500
const MINIMUM_HOST_COMMANDS = 6
const LOCALES_FILE = 'packages/client/ui-commands/src/client/locales.ts'
const SERVICE_FILE = 'packages/client/ui-commands/src/client/service.ts'

/** One literal `*.commands.register({ name, description })` call. */
export interface HostCommandRegistration {
  file: string
  line: number
  name?: string
  description?: string
}

function stringProperty(object: ts.ObjectLiteralExpression, key: string): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined
    if (name !== key) continue
    return ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)
      ? property.initializer.text
      : undefined
  }
  return undefined
}

function isCommandsRegister(call: ts.CallExpression): boolean {
  const register = call.expression
  return ts.isPropertyAccessExpression(register)
    && register.name.text === 'register'
    && ts.isPropertyAccessExpression(register.expression)
    && register.expression.name.text === 'commands'
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)) {
    current = current.expression
  }
  return current
}

/**
 * Find literal Host command registrations in one production source.
 * @param file - Repository-relative path used in diagnostics.
 * @param sourceText - TypeScript source.
 * @returns Registration calls in source order; missing literal fields remain undefined.
 */
export function findHostCommandRegistrations(file: string, sourceText: string): HostCommandRegistration[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const registrations: HostCommandRegistration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCommandsRegister(node)) {
      const argument = node.arguments[0]
      const position = source.getLineAndCharacterOfPosition(node.getStart(source))
      const registration: HostCommandRegistration = { file, line: position.line + 1 }
      if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
        const name = stringProperty(argument, 'name')
        const description = stringProperty(argument, 'description')
        if (name !== undefined) registration.name = name
        if (description !== undefined) registration.description = description
      }
      registrations.push(registration)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return registrations
}

/** Read string properties from a named object-literal variable. */
function objectDictionary(sourceText: string, variableName: string): Map<string, string> {
  const source = ts.createSourceFile(variableName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const values = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === variableName
      && node.initializer !== undefined) {
      const initializer = unwrapExpression(node.initializer)
      if (!ts.isObjectLiteralExpression(initializer)) return
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : undefined
        const value = ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)
          ? property.initializer.text
          : undefined
        if (key !== undefined && value !== undefined) values.set(key, value)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}

/** Read `[command, localeKey]` tuples from `HOST_DESCRIPTION_KEYS`. */
function hostDescriptionKeys(sourceText: string): Map<string, string> {
  const source = ts.createSourceFile(SERVICE_FILE, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const values = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'HOST_DESCRIPTION_KEYS'
      && node.initializer !== undefined
      && ts.isNewExpression(node.initializer)) {
      const entries = node.initializer.arguments?.[0]
      if (entries !== undefined && ts.isArrayLiteralExpression(entries)) {
        for (const entry of entries.elements) {
          if (!ts.isArrayLiteralExpression(entry) || entry.elements.length !== 2) continue
          const name = entry.elements[0]
          const key = entry.elements[1]
          if (name !== undefined && key !== undefined && ts.isStringLiteral(name) && ts.isStringLiteral(key)) {
            values.set(name.text, key.text)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}

/**
 * Compare Host registrations with the Client's English strings and allowlist.
 * @param registrations - Syntax-aware production registrations.
 * @param localesSource - `ui-commands` locale dictionary source.
 * @param serviceSource - `ui-commands` service source owning the allowlist.
 * @returns Human-readable violations.
 */
export function hostCommandDescriptionViolations(
  registrations: readonly HostCommandRegistration[],
  localesSource: string,
  serviceSource: string,
): string[] {
  const violations: string[] = []
  const commands = new Map<string, HostCommandRegistration>()
  for (const registration of registrations) {
    const where = `${registration.file}:${registration.line}`
    if (registration.name === undefined || registration.description === undefined) {
      violations.push(`${where} Host command name and description must be string literals.`)
      continue
    }
    const prior = commands.get(registration.name)
    if (prior !== undefined) {
      violations.push(`${where} duplicates /${registration.name}, first registered at ${prior.file}:${prior.line}.`)
      continue
    }
    commands.set(registration.name, registration)
  }

  const english = objectDictionary(localesSource, 'en')
  const keys = hostDescriptionKeys(serviceSource)
  for (const [name, registration] of commands) {
    const expectedKey = `description.${name}`
    const key = keys.get(name)
    if (key !== expectedKey) {
      violations.push(`${registration.file}:${registration.line} /${name} must map to ${expectedKey} in HOST_DESCRIPTION_KEYS.`)
      continue
    }
    const localizedEnglish = english.get(key)
    if (localizedEnglish !== registration.description) {
      violations.push(
        `${LOCALES_FILE} ${key} must equal the Host description ${JSON.stringify(registration.description)}.`,
      )
    }
  }
  for (const name of keys.keys()) {
    if (!commands.has(name)) violations.push(`${SERVICE_FILE} HOST_DESCRIPTION_KEYS contains stale /${name}.`)
  }
  return violations
}

function sourceFiles(): string[] {
  return globSync('packages/*/*/src/**/*.{ts,tsx}', { cwd: root })
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => !file.endsWith('.d.ts'))
    .sort()
}

function main(): void {
  const files = sourceFiles()
  if (files.length < MINIMUM_HOST_SOURCES) {
    throw new Error(
      `verify-host-command-descriptions: discovery narrowed to ${files.length} source file(s); expected at least ${MINIMUM_HOST_SOURCES}.`,
    )
  }
  const registrations = files.flatMap(file =>
    findHostCommandRegistrations(file, readFileSync(resolve(root, file), 'utf8')))
  if (registrations.length < MINIMUM_HOST_COMMANDS) {
    throw new Error(
      `verify-host-command-descriptions: discovery found ${registrations.length} Host command registration(s); expected at least ${MINIMUM_HOST_COMMANDS}.`,
    )
  }
  const violations = hostCommandDescriptionViolations(
    registrations,
    readFileSync(resolve(root, LOCALES_FILE), 'utf8'),
    readFileSync(resolve(root, SERVICE_FILE), 'utf8'),
  )
  if (violations.length > 0) {
    console.error(`verify-host-command-descriptions: ${violations.length} violation(s):`)
    for (const violation of violations) console.error(`  ${violation}`)
    process.exitCode = 1
    return
  }
  console.log(
    `verify-host-command-descriptions: ${registrations.length} Host command description(s) match the Client English dictionary.`,
  )
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
