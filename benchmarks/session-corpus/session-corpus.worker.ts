/** Isolated worker that seeds the synthetic corpus or measures one Session-controller operation over it. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import type { CheckpointRecord } from '@deepseek-ai/dsh-session-projection-cache'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as SessionTurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { serializeRecord } from '../../packages/storage/storage-json/src/format.ts'
import { sessionShape } from './corpus-shape.ts'
import {
  corpusHeader,
  corpusSessionId,
  forEachConcurrently,
  SEARCH_QUERIES,
  SyntheticCorpusWriter,
  type SyntheticCorpusFacts,
  type WrittenSession,
} from './synthetic-corpus.ts'

/** Process memory after the measured endpoint, with its result still reachable. */
export interface CorpusMemory {
  readonly heapUsedMb: number
  readonly rssMb: number
  readonly peakRssMb: number
}

/** Seeding report: facts of every corpus and the time spent building them. */
export interface SeedReport {
  readonly mode: 'seed'
  readonly corpora: readonly SyntheticCorpusFacts[]
  readonly seedMs: number
}

/** List report: Host boot, then a cold and a repeated Session list. */
export interface ListReport {
  readonly mode: 'list'
  readonly bootMs: number
  readonly firstMs: number
  readonly repeatMs: number
  readonly items: number
  readonly itemsWithProjections: number
  readonly memory: CorpusMemory
}

/** Search report: the first search builds the in-memory index; the second reuses it. */
export interface SearchReport {
  readonly mode: 'search'
  readonly bootMs: number
  readonly firstMs: number
  readonly repeatMs: number
  readonly firstItems: number
  readonly repeatItems: number
  readonly memory: CorpusMemory
}

/** Fork report: one fork of each requested source, in request order. */
export interface ForkReport {
  readonly mode: 'fork'
  readonly bootMs: number
  readonly forks: readonly {
    readonly rank: number
    readonly sourceEvents: number
    readonly forkMs: number
  }[]
  readonly memory: CorpusMemory
}

/** Verification report: replay-validated event counts of every distinct body. */
export interface VerifyReport {
  readonly mode: 'verify'
  readonly anchors: readonly { readonly anchor: number; readonly rank: number; readonly events: number }[]
}

/** Any worker report. */
export type SessionCorpusReport = SeedReport | ListReport | SearchReport | ForkReport | VerifyReport

const BENCH_MODEL = { provider: 'bench', model: 'bench' } as const
/** Bound on waiting for fire-and-forget projection-cache write-backs after seeding. */
const SEED_DRAIN_TIMEOUT_MS = 120_000

function megabytes(bytes: number): number {
  return Math.round(bytes / 104_857.6) / 10
}

async function memory(): Promise<CorpusMemory> {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  if (gc === undefined) throw new Error('Session corpus benchmark requires --expose-gc')
  gc()
  await scheduler.yield()
  gc()
  const usage = process.memoryUsage()
  return {
    heapUsedMb: megabytes(usage.heapUsed),
    rssMb: megabytes(usage.rss),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 102.4) / 10,
  }
}

/** Mount the shipped Web Host's Session list, search, and fork dependencies. */
async function mountHost(root: string): Promise<{ readonly ctx: Context; readonly controller: SessionController }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'zstd' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5_000 })
  // Content search is opt-in; enabled deployments defer the in-memory index to the first search.
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' })
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(SessionStatsPlugin)
  await ctx.plugin(SessionTurnOutlinePlugin)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop, { agents: [] })
  // Transport, upload, model-default, and Workspace services are outside every measured path.
  const dispose = (): void => {}
  ctx.provide('typert', { lookups: { configure: () => dispose }, contexts: { configureHost: () => dispose } } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => dispose } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => BENCH_MODEL } as never)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  const controller = new SessionController(ctx, { nativeOpen: false }, { canOpenPath: () => false })
  return { ctx, controller }
}

/** Run one operation against the projection-cache table stored under `root`. */
async function withCacheTable<Value>(
  root: string,
  operation: (table: KvTable<SessionId, CheckpointRecord>) => Promise<Value>,
): Promise<Value> {
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const domain = await ctx.storageDomain.open(projectionCacheDomainSpec)
    try {
      return await operation(domain.table('sessions'))
    } finally {
      await domain.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function seed(root: string, counts: readonly number[]): Promise<SeedReport> {
  const started = performance.now()
  const writer = new SyntheticCorpusWriter()
  const folded = new Map<number, SessionHeader>()
  for (const count of counts) {
    for (let rank = 0; rank < count; rank++) {
      const { anchor } = sessionShape(rank, count)
      if (!folded.has(anchor)) folded.set(anchor, corpusHeader(rank, count))
    }
  }
  const foldRoot = join(root, 'fold')
  const host = await mountHost(foldRoot)
  try {
    for (const [anchor, header] of folded) {
      // The production cold-read write-back folds each shared body once.
      host.ctx.sessionProjectionCache.coldSnapshot(header, SessionLogOffset(0), await writer.author(anchor))
    }
    // Write-backs are fire-and-forget; the cache serves a record only after it is durable.
    const deadline = performance.now() + SEED_DRAIN_TIMEOUT_MS
    while ([...folded.values()].some(header => host.ctx.sessionProjectionCache.cachedSnapshot(header) === undefined)) {
      if (performance.now() > deadline) throw new Error('projection-cache write-back did not become durable')
      await scheduler.wait(20)
    }
  } finally {
    await host.ctx.fiber.dispose()
  }
  const records = await withCacheTable(foldRoot, table => Promise.resolve(new Map(
    [...folded].map(([anchor, header]) => [anchor, table.get(header.id) as CheckpointRecord]),
  )))
  const corpora: SyntheticCorpusFacts[] = []
  for (const count of counts) {
    const corpusRoot = join(root, `corpus-${String(count)}`)
    const written = await writer.writeCorpus(join(corpusRoot, 'sessions'), count)
    // Sessions of one anchor share events, so their records differ only in the header-bound identity.
    // Per-record documents are written directly: the domain's one-fsync-per-put chain would dominate seeding,
    // and the list endpoint rejects a corpus whose rows the cache does not serve.
    const table = join(corpusRoot, 'storages', projectionCacheDomainSpec.name, 'sessions')
    await mkdir(table, { recursive: true })
    await forEachConcurrently(written.sessions.length, async (rank) => {
      const { header, anchor } = written.sessions[rank] as WrittenSession
      const source = records.get(anchor) as CheckpointRecord
      await writeFile(join(table, `${header.id}.json`), serializeRecord(projectionCacheDomainSpec.version, {
        identity: { ...source.identity, createdAt: header.createdAt, cwd: header.cwd },
        rows: source.rows,
      }))
    })
    corpora.push(written.facts)
  }
  return { mode: 'seed', corpora, seedMs: performance.now() - started }
}

async function measureList(root: string, expected: number): Promise<ListReport> {
  const started = performance.now()
  const { ctx, controller } = await mountHost(root)
  try {
    const booted = performance.now()
    const signal = new AbortController().signal
    const first = await controller.list({}, signal)
    const firstDone = performance.now()
    const repeated = await controller.list({}, signal)
    const done = performance.now()
    if (first.items.length !== expected || repeated.items.length !== expected) {
      throw new Error(`Session list returned ${String(first.items.length)} of ${String(expected)} Sessions`)
    }
    return {
      mode: 'list',
      bootMs: booted - started,
      firstMs: firstDone - booted,
      repeatMs: done - firstDone,
      items: first.items.length,
      itemsWithProjections: first.items.filter(item => item.projections !== undefined).length,
      memory: await memory(),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function measureSearch(root: string): Promise<SearchReport> {
  const started = performance.now()
  const { ctx, controller } = await mountHost(root)
  try {
    const booted = performance.now()
    const signal = new AbortController().signal
    const first = await controller.search({ query: SEARCH_QUERIES[0] }, signal)
    const firstDone = performance.now()
    const repeated = await controller.search({ query: SEARCH_QUERIES[1] }, signal)
    const done = performance.now()
    if (first.items.length === 0 || repeated.items.length === 0) {
      throw new Error('Session search matched no synthetic Session')
    }
    return {
      mode: 'search',
      bootMs: booted - started,
      firstMs: firstDone - booted,
      repeatMs: done - firstDone,
      firstItems: first.items.length,
      repeatItems: repeated.items.length,
      memory: await memory(),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function measureFork(root: string, ranks: readonly number[]): Promise<ForkReport> {
  const started = performance.now()
  const { ctx, controller } = await mountHost(root)
  try {
    const booted = performance.now()
    const forks: ForkReport['forks'][number][] = []
    for (const rank of ranks) {
      const forkStarted = performance.now()
      const { sessionId } = await controller.fork({ sessionId: corpusSessionId(rank) })
      const forkMs = performance.now() - forkStarted
      const child = ctx.sessions.get(sessionId)
      if (child === undefined) throw new Error(`fork of rank ${String(rank)} did not publish its child`)
      forks.push({ rank, sourceEvents: child.inheritedEventCount, forkMs })
    }
    return { mode: 'fork', bootMs: booted - started, forks, memory: await memory() }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function verify(root: string, count: number): Promise<VerifyReport> {
  const { ctx } = await mountHost(root)
  try {
    const anchors: VerifyReport['anchors'][number][] = []
    for (let rank = 0; rank < count; rank++) {
      const { anchor } = sessionShape(rank, count)
      if (anchors.some(entry => entry.anchor === anchor)) continue
      // Exact reads replay the log through Session validation.
      const { events } = await ctx.sessionQuery.readSession(corpusSessionId(rank))
      anchors.push({ anchor, rank, events: events.length })
    }
    return { mode: 'verify', anchors }
  } finally {
    await ctx.fiber.dispose()
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, Object.fromEntries([
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-session-projection-cache',
].map(name => [name, import.meta.resolve(name)])))

const [root, mode, ...rest] = process.argv.slice(2)
const numbers = rest.map(Number)
if (root === undefined || numbers.some(value => !Number.isSafeInteger(value) || value < 0)) {
  throw new Error('usage: session-corpus.worker.js <root> <seed counts...|list count|search|fork ranks...|verify count>')
}
let report: SessionCorpusReport
switch (mode) {
  case 'seed':
    report = await seed(root, numbers)
    break
  case 'list':
    report = await measureList(root, numbers[0] ?? 0)
    break
  case 'search':
    report = await measureSearch(root)
    break
  case 'fork':
    report = await measureFork(root, numbers)
    break
  case 'verify':
    report = await verify(root, numbers[0] ?? 0)
    break
  default:
    throw new Error(`unknown Session corpus mode ${String(mode)}`)
}
process.stdout.write(JSON.stringify(report) + '\n')
