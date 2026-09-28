/**
 * DSH_COVERAGE_TEST_TIMEOUT_MS reaches every inline Vitest project. The root
 * config spreads the budget into each project because Vitest forwards only a
 * fixed list of CLI overrides into projects: --testTimeout is on it,
 * --hookTimeout and --expect.poll.timeout are not, so a flag-based budget
 * raises only the per-test default. A budget below the fixture's waits must
 * end all three inside both projects; unset must keep Vitest's defaults, under
 * which the same fixture passes.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { COVERAGE_TEST_TIMEOUT_ENV } from './coverage-partitions.ts'

const root = resolve(import.meta.dirname, '..')
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const fixture = 'scripts/fixtures/lane-test-budget.fixture.ts'

// The root config with every project's inventory narrowed to the fixture, so
// the fixture never joins the ordinary inventory and still runs once per
// project. Absolute import in POSIX spelling because the temporary directory
// is outside the repository; the sibling package.json keeps Vite bundling the
// config as ESM, which the repository root's "type" otherwise supplies.
const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-lane-test-budget-'))
const configPath = join(temporaryRoot, 'vitest.config.ts')
writeFileSync(join(temporaryRoot, 'package.json'), '{ "type": "module" }\n', 'utf8')
writeFileSync(configPath, [
  `import base from ${JSON.stringify(resolve(root, 'vitest.config.ts').split('\\').join('/'))}`,
  'export default {',
  '  ...base,',
  '  test: {',
  '    ...base.test,',
  '    projects: (base.test.projects ?? []).map(project => ({',
  '      ...project,',
  `      test: { ...project.test, include: [${JSON.stringify(fixture)}] },`,
  '    })),',
  '  },',
  '}',
  '',
].join('\n'), 'utf8')
afterAll(() => { rmSync(temporaryRoot, { recursive: true, force: true }) })

function runFixture(budget: string | undefined): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  for (const name of Object.keys(env)) {
    // The parent worker's Vitest state and the coverage coordinator's own
    // variables describe this process, not the child; the Actions reporter
    // would otherwise annotate the parent job with the fixture's failures.
    if (name.startsWith('VITEST') || name.startsWith('DSH_COVERAGE_') || name === 'GITHUB_ACTIONS') Reflect.deleteProperty(env, name)
  }
  if (budget !== undefined) env[COVERAGE_TEST_TIMEOUT_ENV] = budget
  const child = spawnSync(process.execPath, [vitestCli, 'run', '--config', configPath], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (child.error !== undefined) throw child.error
  return { status: child.status, output: `${child.stdout}\n${child.stderr}` }
}

describe('lane test budget', () => {
  it('ends per-test, hook, and expect.poll waits in both inline projects', { timeout: 90_000 }, () => {
    const { status, output } = runFixture('200')

    expect(output).toMatch(/\|thread-safe\| scripts\/fixtures\/lane-test-budget\.fixture\.ts/)
    expect(output).toMatch(/\|process-bound\| scripts\/fixtures\/lane-test-budget\.fixture\.ts/)
    expect(output).toMatch(/Test Files\s+2 failed \(2\)/)
    expect(output).toMatch(/Tests\s+6 failed \(6\)/)
    expect(output.match(/Test timed out in 200ms\./g)).toHaveLength(2)
    expect(output.match(/Hook timed out in 200ms\./g)).toHaveLength(2)
    expect(output.match(/Matcher did not succeed in time\./g)).toHaveLength(2)
    for (const [, polled] of output.matchAll(/expected (\d+) to be greater than 500/g)) {
      expect(Number(polled)).toBeLessThan(500)
    }
    expect(status).toBe(1)
  })

  it('keeps Vitest defaults when the budget is unset', { timeout: 90_000 }, () => {
    const { status, output } = runFixture(undefined)

    expect(output).toMatch(/Test Files\s+2 passed \(2\)/)
    expect(output).toMatch(/Tests\s+6 passed \(6\)/)
    expect(status).toBe(0)
  })

  it('refuses a malformed budget at config load before any test runs', { timeout: 90_000 }, () => {
    const { status, output } = runFixture('90000ms')

    expect(output).toContain(`${COVERAGE_TEST_TIMEOUT_ENV} must be a positive integer, got "90000ms".`)
    expect(output).not.toMatch(/lane-test-budget\.fixture\.ts \(/)
    expect(status).toBe(1)
  })
})
