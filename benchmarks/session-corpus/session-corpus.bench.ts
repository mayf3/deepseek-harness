/** Required budgets for listing, searching, and forking Sessions in corpora with the measured local length distribution. */

import { mkdtemp, rm } from 'node:fs/promises'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
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
  VerifyReport,
} from './session-corpus.worker.ts'

/** Corpus used by search and fork, and the extreme corpus used only by the list. */
const CORPUS = { standard: 1_000, extreme: 5_000 } as const
/** Fresh processes per list and fork scenario; the median enforces each budget. */
const ATTEMPTS = { list: 5, fork: 3 } as const
/** One cold content-search sample: the index build takes over two minutes on standard hosted CI. */
const SEARCH_ATTEMPTS = 1
/** Midpoints of ten equal length strata of the standard corpus, then its p99 and longest Session. */
const FORK_STRATA = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950] as const
const FORK_P99_RANK = 990
const FORK_LONGEST_RANK = 999
const SEED_TIMEOUT_MS = 600_000
const WORKER_TIMEOUT_MS = 300_000
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-corpus', 'session-corpus.worker.js')

/**
 * Standard two-CPU hosted CI expectations, rounded above the recorded medians before variance headroom.
 * Recorded medians: list 1,000 830.3 / 1,155.3 / 876.7 ms; list 5,000 3,569.5 / 5,143.5 / 4,290.5 ms;
 * search 139,470 / 3,369 ms; fork 89.6 / 1,485.7 / 17,538.1 ms.
 */
const EXPECTED_CI_MS = {
  listBoot: { standard: 850, extreme: 3_600 },
  listFirst: { standard: 1_200, extreme: 5_200 },
  listRepeat: { standard: 900, extreme: 4_300 },
  searchFirst: 140_000,
  searchRepeat: 3_400,
  forkStratumMedian: 90,
  forkP99: 1_500,
  forkLongest: 17_600,
} as const

function budget(expectedCiMs: number): number {
  return Math.ceil(expectedCiMs * PERFORMANCE_BUDGET_HEADROOM)
}

type CorpusSize = keyof typeof CORPUS

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
    expect(() => sessionShape(CORPUS.standard, CORPUS.standard)).toThrow('outside')
  })

  it('accepts recorded hosted medians and rejects medians a quarter above their expectation', () => {
    const recorded = [
      [median([3_569.4, 3_634.7, 3_569.5, 3_536, 3_624.8]), EXPECTED_CI_MS.listBoot.extreme],
      [median([5_206.2, 5_043, 5_143.5, 5_167.9, 5_047.4]), EXPECTED_CI_MS.listFirst.extreme],
      [139_470, EXPECTED_CI_MS.searchFirst],
      [median([17_573.2, 17_532.9, 17_538.1]), EXPECTED_CI_MS.forkLongest],
      [median([88.2, 89.6, 91.8]), EXPECTED_CI_MS.forkStratumMedian],
    ] as const
    for (const [value, expected] of recorded) {
      expectWithinBudget(value, budget(expected))
      expect(() => expectWithinBudget(Math.ceil(expected * 1.26), budget(expected))).toThrow()
    }
    expect(budget(EXPECTED_CI_MS.listFirst.extreme)).toBe(6_500)
  })
})

describe('Session corpus operations', () => {
  let scratch = ''
  const root = (size: CorpusSize): string => join(scratch, `corpus-${String(CORPUS[size])}`)

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-session-corpus-bench-'))
    const seeded = await run<SeedReport>([scratch, 'seed', String(CORPUS.standard), String(CORPUS.extreme)], SEED_TIMEOUT_MS)
    console.log(JSON.stringify({ benchmark: 'session-corpus/seed', ...seeded, environment: environment() }))
  }, SEED_TIMEOUT_MS)

  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  it('stores replay-valid Sessions for every measured anchor', async () => {
    const report = await run<VerifyReport>([root('standard'), 'verify', String(CORPUS.standard)])
    expect(report.anchors).toHaveLength(ANCHOR_COUNT)
    for (const { anchor, events } of report.anchors) {
      expect(events).toBeGreaterThanOrEqual(anchorShape(anchor).events)
    }
  })

  for (const size of ['standard', 'extreme'] as const) {
    const budgets = {
      bootMs: budget(EXPECTED_CI_MS.listBoot[size]),
      firstMs: budget(EXPECTED_CI_MS.listFirst[size]),
      repeatMs: budget(EXPECTED_CI_MS.listRepeat[size]),
    }

    it(`lists ${String(CORPUS[size])} Sessions after a cold Host boot`, async () => {
      const reports: ListReport[] = []
      for (let attempt = 0; attempt < ATTEMPTS.list; attempt++) {
        reports.push(await run<ListReport>([root(size), 'list', String(CORPUS[size])]))
      }
      const samples = {
        bootMs: rounded(reports.map(report => report.bootMs)),
        firstMs: rounded(reports.map(report => report.firstMs)),
        repeatMs: rounded(reports.map(report => report.repeatMs)),
        peakRssMb: reports.map(report => report.memory.peakRssMb),
        heapUsedMb: reports.map(report => report.memory.heapUsedMb),
      }
      console.log(JSON.stringify({ benchmark: `session-corpus/list-${String(CORPUS[size])}`, samples, budgets, environment: environment() }))
      for (const report of reports) expect(report.itemsWithProjections).toBe(CORPUS[size])
      expectWithinBudget(median(samples.bootMs), budgets.bootMs)
      expectWithinBudget(median(samples.firstMs), budgets.firstMs)
      expectWithinBudget(median(samples.repeatMs), budgets.repeatMs)
    })
  }

  it(`searches ${String(CORPUS.standard)} Sessions with a cold and then a built content index`, async () => {
    const budgets = { firstMs: budget(EXPECTED_CI_MS.searchFirst), repeatMs: budget(EXPECTED_CI_MS.searchRepeat) }
    const reports: SearchReport[] = []
    for (let attempt = 0; attempt < SEARCH_ATTEMPTS; attempt++) {
      reports.push(await run<SearchReport>([root('standard'), 'search']))
    }
    console.log(JSON.stringify({ benchmark: 'session-corpus/search', reports, budgets, environment: environment() }))
    expectWithinBudget(median(reports.map(report => report.firstMs)), budgets.firstMs)
    expectWithinBudget(median(reports.map(report => report.repeatMs)), budgets.repeatMs)
  }, SEED_TIMEOUT_MS)

  it(`forks Sessions across the length distribution of ${String(CORPUS.standard)} Sessions`, async () => {
    const budgets = {
      stratumMedianMs: budget(EXPECTED_CI_MS.forkStratumMedian),
      p99Ms: budget(EXPECTED_CI_MS.forkP99),
      longestMs: budget(EXPECTED_CI_MS.forkLongest),
    }
    const ranks = [...FORK_STRATA, FORK_P99_RANK, FORK_LONGEST_RANK].map(String)
    const reports: ForkReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS.fork; attempt++) {
      reports.push(await run<ForkReport>([root('standard'), 'fork', ...ranks]))
    }
    const forkMs = (report: ForkReport, rank: number): number => {
      const fork = report.forks.find(entry => entry.rank === rank)
      if (fork === undefined) throw new Error(`fork report omits rank ${String(rank)}`)
      return fork.forkMs
    }
    const samples = {
      stratumMedianMs: rounded(reports.map(report => median(FORK_STRATA.map(rank => forkMs(report, rank))))),
      p99Ms: rounded(reports.map(report => forkMs(report, FORK_P99_RANK))),
      longestMs: rounded(reports.map(report => forkMs(report, FORK_LONGEST_RANK))),
      perRank: reports.map(report => report.forks.map(({ rank, sourceEvents, forkMs }) => ({ rank, sourceEvents, forkMs: Math.round(forkMs) }))),
      peakRssMb: reports.map(report => report.memory.peakRssMb),
    }
    console.log(JSON.stringify({ benchmark: 'session-corpus/fork', samples, budgets, environment: environment() }))
    expectWithinBudget(median(samples.stratumMedianMs), budgets.stratumMedianMs)
    expectWithinBudget(median(samples.p99Ms), budgets.p99Ms)
    expectWithinBudget(median(samples.longestMs), budgets.longestMs)
  }, SEED_TIMEOUT_MS)
})
