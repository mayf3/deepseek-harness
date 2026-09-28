/** Required budgets for listing, searching, and forking Sessions in corpora with the measured local length distribution. */

import { mkdtemp, rm } from 'node:fs/promises'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget } from '../support/calibration.ts'
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
/** One cold content-search sample: the index build takes about a minute on the reference machine. */
const SEARCH_ATTEMPTS = 1
/** Midpoints of ten equal length strata of the standard corpus, then its p99 and longest Session. */
const FORK_STRATA = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950] as const
const FORK_P99_RANK = 990
const FORK_LONGEST_RANK = 999
const SEED_TIMEOUT_MS = 600_000
const WORKER_TIMEOUT_MS = 300_000
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-corpus', 'session-corpus.worker.js')

/** Apple M5 Pro / Node 26.5 expectations, before shared CI scaling and variance headroom. */
const EXPECTED_MS = {
  listBoot: { standard: 300, extreme: 1_300 },
  listFirst: { standard: 400, extreme: 1_700 },
  listRepeat: { standard: 300, extreme: 1_600 },
  searchFirst: 60_000,
  searchRepeat: 1_100,
  forkStratumMedian: 40,
  forkP99: 700,
  forkLongest: 6_500,
} as const

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

function expectWithinBudget(value: number, budget: number): void {
  expect(value).toBeLessThanOrEqual(budget)
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

  it('rejects endpoint medians more than a quarter above their CI expectation', () => {
    const expectations = [
      EXPECTED_MS.listFirst.extreme, EXPECTED_MS.searchFirst, EXPECTED_MS.forkLongest, EXPECTED_MS.forkStratumMedian,
    ]
    for (const expected of expectations) {
      const budget = ciTimeBudget(expected)
      expectWithinBudget(expected * 2, budget)
      expect(() => expectWithinBudget(Math.ceil(expected * 2 * 1.26), budget)).toThrow()
    }
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
      bootMs: ciTimeBudget(EXPECTED_MS.listBoot[size]),
      firstMs: ciTimeBudget(EXPECTED_MS.listFirst[size]),
      repeatMs: ciTimeBudget(EXPECTED_MS.listRepeat[size]),
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
    const budgets = { firstMs: ciTimeBudget(EXPECTED_MS.searchFirst), repeatMs: ciTimeBudget(EXPECTED_MS.searchRepeat) }
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
      stratumMedianMs: ciTimeBudget(EXPECTED_MS.forkStratumMedian),
      p99Ms: ciTimeBudget(EXPECTED_MS.forkP99),
      longestMs: ciTimeBudget(EXPECTED_MS.forkLongest),
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
