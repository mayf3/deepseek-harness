/**
 * Verify that no package builds its own undici agent or hands `fetch` an explicit dispatcher.
 *
 * Node's built-in `fetch` routes through undici's global dispatcher, which `@deepseek-ai/dsh-http-proxy`
 * installs at launch. An explicitly supplied `dispatcher` overrides that global one, so a call site
 * that constructs `new Agent(...)` itself connects directly no matter what proxy the user configured
 * — the exact defect `web-fetch-http` carried before proxy support existed, where its DNS-pinning
 * agent silently bypassed every proxy.
 *
 * `createDispatcher()` from that package is the sanctioned way to get agent options AND the policy.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** The package that owns dispatcher construction; its own agents are the implementation. */
export const DISPATCHER_OWNER = 'packages/net/http-proxy/'

/** A line carrying this marker states why it is exempt and is left alone. */
export const ALLOW_MARKER = 'proxy-exempt:'

/** Constructing an undici agent, or naming a `dispatcher` option, outside the owning package. */
const PATTERNS: readonly { readonly probe: RegExp; readonly what: string }[] = [
  { probe: /\bnew\s+(?:undici\.)?(?:Agent|ProxyAgent|EnvHttpProxyAgent)\s*\(/, what: 'constructs an undici agent' },
  { probe: /\bdispatcher\s*:/, what: 'passes an explicit `dispatcher`' },
]

/** One source line that would bypass the configured proxy. */
export interface DispatcherViolation {
  /** Repository-relative path, in POSIX separators. */
  readonly file: string
  /** One-based line number. */
  readonly line: number
  /** Which rule the line broke. */
  readonly what: string
  /** The offending line, trimmed. */
  readonly text: string
}

/**
 * Find every bare-dispatcher line in one source file.
 *
 * @param file - repository-relative path, used to exempt the owning package and to report location.
 * @param sourceText - the file's contents.
 * @returns one violation per offending line, in file order.
 */
export function findDispatcherViolations(file: string, sourceText: string): DispatcherViolation[] {
  const posix = file.replaceAll('\\', '/')
  if (posix.startsWith(DISPATCHER_OWNER)) return []
  const violations: DispatcherViolation[] = []
  sourceText.split('\n').forEach((text, index) => {
    if (text.includes(ALLOW_MARKER)) return
    for (const { probe, what } of PATTERNS) {
      if (probe.test(text)) violations.push({ file: posix, line: index + 1, what, text: text.trim() })
    }
  })
  return violations
}

/**
 * Scan every package and app source file in the repository.
 *
 * @returns every violation found, grouped by the order the files were scanned.
 */
export function scanRepository(): DispatcherViolation[] {
  const files = [
    ...globSync('packages/*/*/src/**/*.ts', { cwd: root }),
    ...globSync('apps/*/src/**/*.ts', { cwd: root }),
  ]
  return files.flatMap(file => findDispatcherViolations(file, readFileSync(resolve(root, file), 'utf8')))
}

function main(): void {
  const violations = scanRepository()
  if (violations.length === 0) {
    console.log(`verify-no-bare-dispatcher: no bare dispatcher outside ${DISPATCHER_OWNER}.`)
    return
  }
  console.error('verify-no-bare-dispatcher: a dispatcher built outside @deepseek-ai/dsh-http-proxy bypasses the configured proxy.\n')
  for (const violation of violations) {
    console.error(`  ${violation.file}:${String(violation.line)} ${violation.what}`)
    console.error(`    ${violation.text}`)
  }
  console.error('\nUse `createDispatcher(url, options)` from @deepseek-ai/dsh-http-proxy, or annotate the line')
  console.error(`with a \`${ALLOW_MARKER} <reason>\` comment when the request must genuinely ignore the proxy.`)
  process.exit(1)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
