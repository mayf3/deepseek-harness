/** Required budgets for listing, searching, and forking Sessions in corpora with the measured local length distribution. */

import { mkdtemp, rm } from 'node:fs/promises'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { anchorShape, ANCHOR_COUNT, sessionShape } from './corpus-shape.ts'
import type {
  ForkReport,
  ListReport,
  SearchReport,
  SeedReport,
  SessionCorpusReport,
} from './session-corpus.worker.ts'

/** Session counts: search and fork share the query corpus; the list corpus is the largest that fits the time limit. */
const CORPUS = { query: 1_000, list: 3_000 } as const
/** Upper bound on this file's hosted CI wall time, from seeding through the last case. */
const FILE_LIMIT_MS = 300_000
/** Fresh processes per list and fork-strata scenario; the median enforces each budget. */
const ATTEMPTS = { list: 3, fork: 3 } as const
/** Midpoints of ten equal length strata of the query corpus, then its p99 Session. */
const FORK_STRATA = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950] as const
const FORK_P99_RANK = 990
/** The longest Session; one sample, because one fork takes about 18 s on standard hosted CI. */
const FORK_LONGEST_RANK = 999
const WORKER_TIMEOUT_MS = 240_000
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-corpus', 'session-corpus.worker.js')

/**
 * Standard two-CPU hosted CI expectations, rounded above the recorded medians before variance headroom.
 * Recorded medians: list 1,000 830.3 / 1,155.3 / 876.7 ms and list 5,000 3,569.5 / 5,143.5 / 4,290.5 ms,
 * interpolated to the list corpus; search 139,470 / 3,369 ms; fork 89.6 / 1,485.7 / 17,538.1 ms.
 */
const EXPECTED_CI_MS = {
  listBoot: 2_200,
  listFirst: 3_200,
  listRepeat: 2_600,
  searchFirst: 140_000,
  searchRepeat: 3_400,
  forkStratumMedian: 90,
  forkP99: 1_500,
  forkLongest: 17_600,
} as const

function budget(expectedCiMs: number): number {
  return Math.ceil(expectedCiMs * PERFORMANCE_BUDGET_HEADROOM)
}

type CorpusName = keyof typeof CORPUS

async function run<Report extends SessionCorpusReport>(args: readonly string[], timeoutMs = WORKER_TIMEOUT_MS): Promise<Report> {
  const outcome = await runBuiltBenchmarkWorker<Report>({ worker: WORKER, args, timeoutMs, exposeGc: true })
  if (outcome.report === undefined) {
    const stderr = outcome.stderr.trim().split('\n').slice(-20).join('\n')
    throw new Error(`session-corpus worker ${args[1] ?? ''} failed: exit=${String(outcome.exitCode)}, `
      + `signal=${String(outcome.signal)}, timedOut=${String(outcome.timedOut)}\n${stderr}`)
  }
  return outcome.report
}

function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] as number
}

function rounded(values: readonly number[]): number[] {
  return values.map(value => Math.round(value * 10) / 10)
}

function expectWithinBudget(value: number, limit: number): void {
  expect(value).toBeLessThanOrEqual(limit)
}

function environment() {
  return {
    cpu: cpus()[0]?.model,
    availableParallelism: availableParallelism(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
  }
}

describe('Session corpus workload', () => {
  it('is at least the measured distribution at every rank of both corpora', () => {
    for (const count of Object.values(CORPUS)) {
      const shapes = Array.from({ length: count }, (_, rank) => sessionShape(rank, count))
      expect(new Set(shapes.map(shape => shape.anchor)).size).toBe(ANCHOR_COUNT)
      expect(shapes[Math.floor(count / 2) - 1]).toEqual(anchorShape(4))
      expect(shapes.at(-1)).toEqual({ anchor: ANCHOR_COUNT - 1, events: 84_467, logicalBytes: 48_139_877, turns: 2_181 })
      for (let rank = 1; rank < count; rank++) {
        const [previous, current] = [shapes[rank - 1], shapes[rank]] as const
        expect(current?.events).toBeGreaterThanOrEqual(previous?.events ?? 0)
        expect(current?.logicalBytes).toBeGreaterThanOrEqual(previous?.logicalBytes ?? 0)
      }
    }
    expect(() => sessionShape(CORPUS.query, CORPUS.query)).toThrow('outside')
  })

  it('accepts recorded hosted medians and rejects medians a quarter above their expectation', () => {
    const recorded = [
      [139_470, EXPECTED_CI_MS.searchFirst],
      [median([17_573.2, 17_532.9, 17_538.1]), EXPECTED_CI_MS.forkLongest],
      [median([88.2, 89.6, 91.8]), EXPECTED_CI_MS.forkStratumMedian],
    ] as const
    for (const [value, expected] of recorded) {
      expectWithinBudget(value, budget(expected))
      expect(() => expectWithinBudget(Math.ceil(expected * 1.26), budget(expected))).toThrow()
    }
    expect(budget(EXPECTED_CI_MS.forkLongest)).toBe(22_000)
  })
})

describe('Session corpus operations', () => {
  let scratch = ''
  let started = 0
  let seeded: SeedReport | undefined
  const root = (name: CorpusName): string => join(scratch, `corpus-${String(CORPUS[name])}`)

  beforeAll(async () => {
    started = performance.now()
    scratch = await mkdtemp(join(tmpdir(), 'dsh-session-corpus-bench-'))
    seeded = await run<SeedReport>([scratch, 'seed', String(CORPUS.query), String(CORPUS.list)])
    console.log(JSON.stringify({ benchmark: 'session-corpus/seed', ...seeded, environment: environment() }))
  }, WORKER_TIMEOUT_MS)

  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  it('writes corpora at least as long as the measured distribution', () => {
    for (const count of [CORPUS.query, CORPUS.list]) {
      const facts = seeded?.corpora.find(corpus => corpus.sessions === count)
      const shapes = Array.from({ length: count }, (_, rank) => sessionShape(rank, count))
      expect(facts?.distinctBodies).toBe(ANCHOR_COUNT)
      expect(facts?.events).toBeGreaterThanOrEqual(shapes.reduce((sum, shape) => sum + shape.events, 0))
      expect(facts?.logicalBytes).toBeGreaterThanOrEqual(shapes.reduce((sum, shape) => sum + shape.logicalBytes, 0))
    }
  })

  it(`lists ${String(CORPUS.list)} Sessions after a cold Host boot`, async () => {
    const budgets = {
      bootMs: budget(EXPECTED_CI_MS.listBoot),
      firstMs: budget(EXPECTED_CI_MS.listFirst),
      repeatMs: budget(EXPECTED_CI_MS.listRepeat),
    }
    const reports: ListReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS.list; attempt++) {
      reports.push(await run<ListReport>([root('list'), 'list', String(CORPUS.list)]))
    }
    const samples = {
      bootMs: rounded(reports.map(report => report.bootMs)),
      firstMs: rounded(reports.map(report => report.firstMs)),
      repeatMs: rounded(reports.map(report => report.repeatMs)),
      peakRssMb: reports.map(report => report.memory.peakRssMb),
      heapUsedMb: reports.map(report => report.memory.heapUsedMb),
    }
    console.log(JSON.stringify({ benchmark: `session-corpus/list-${String(CORPUS.list)}`, samples, budgets, environment: environment() }))
    for (const report of reports) expect(report.itemsWithProjections).toBe(CORPUS.list)
    expectWithinBudget(median(samples.bootMs), budgets.bootMs)
    expectWithinBudget(median(samples.firstMs), budgets.firstMs)
    expectWithinBudget(median(samples.repeatMs), budgets.repeatMs)
  })

  it(`searches ${String(CORPUS.query)} Sessions with a cold and then a built content index`, async () => {
    const budgets = { firstMs: budget(EXPECTED_CI_MS.searchFirst), repeatMs: budget(EXPECTED_CI_MS.searchRepeat) }
    // One sample: the cold index build dominates this file's time.
    const report = await run<SearchReport>([root('query'), 'search'])
    console.log(JSON.stringify({ benchmark: 'session-corpus/search', report, budgets, environment: environment() }))
    expectWithinBudget(report.firstMs, budgets.firstMs)
    expectWithinBudget(report.repeatMs, budgets.repeatMs)
  }, WORKER_TIMEOUT_MS)

  it(`forks Sessions across the length distribution of ${String(CORPUS.query)} Sessions`, async () => {
    const budgets = {
      stratumMedianMs: budget(EXPECTED_CI_MS.forkStratumMedian),
      p99Ms: budget(EXPECTED_CI_MS.forkP99),
      longestMs: budget(EXPECTED_CI_MS.forkLongest),
    }
    const reports: ForkReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS.fork; attempt++) {
      reports.push(await run<ForkReport>([root('query'), 'fork', ...[...FORK_STRATA, FORK_P99_RANK].map(String)]))
    }
    const longest = await run<ForkReport>([root('query'), 'fork', String(FORK_LONGEST_RANK)])
    const forkMs = (report: ForkReport, rank: number): number => {
      const fork = report.forks.find(entry => entry.rank === rank)
      if (fork === undefined) throw new Error(`fork report omits rank ${String(rank)}`)
      return fork.forkMs
    }
    const samples = {
      stratumMedianMs: rounded(reports.map(report => median(FORK_STRATA.map(rank => forkMs(report, rank))))),
      p99Ms: rounded(reports.map(report => forkMs(report, FORK_P99_RANK))),
      longestMs: Math.round(forkMs(longest, FORK_LONGEST_RANK) * 10) / 10,
      perRank: reports.map(report => report.forks.map(({ rank, sourceEvents, forkMs }) => ({ rank, sourceEvents, forkMs: Math.round(forkMs) }))),
      peakRssMb: [...reports, longest].map(report => report.memory.peakRssMb),
    }
    console.log(JSON.stringify({ benchmark: 'session-corpus/fork', samples, budgets, environment: environment() }))
    expectWithinBudget(median(samples.stratumMedianMs), budgets.stratumMedianMs)
    expectWithinBudget(median(samples.p99Ms), budgets.p99Ms)
    expectWithinBudget(samples.longestMs, budgets.longestMs)
  }, WORKER_TIMEOUT_MS)

  it(`completes within ${String(FILE_LIMIT_MS / 60_000)} minutes`, () => {
    const elapsedMs = performance.now() - started
    console.log(JSON.stringify({ benchmark: 'session-corpus/total', elapsedMs: Math.round(elapsedMs), limitMs: FILE_LIMIT_MS }))
    expectWithinBudget(elapsedMs, FILE_LIMIT_MS)
  })
})
