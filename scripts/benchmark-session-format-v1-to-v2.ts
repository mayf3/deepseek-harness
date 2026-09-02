/**
 * Manual performance acceptance for the released v2 Session format.
 *
 * Run the full gate from the repository root with:
 *
 *   pnpm run benchmark:session-format-v1-to-v2
 *
 * Use `--smoke` for a short correctness and reporting pass. The smoke mode
 * reports timing deltas but does not enforce the acceptance ceiling.
 */

import { deepStrictEqual, ok } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionHeader,
  SessionId as SessionIdType,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  snapshotSessionFormatArtifact,
} from '@deepseek-ai/dsh-session-format'
import type {
  EncodedSessionFormatArtifact,
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatJsonObject,
} from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedV1Artifact,
  releasedV1SessionFormatCodec,
} from '@deepseek-ai/dsh-session-format-v0-to-v1'
import {
  assertReleasedV2Artifact,
  releasedV2SessionFormatCodec,
  restoreReleasedV2Artifact,
  sessionFormatV1ToV2,
} from '../packages/session/session-format-v1-to-v2/src/index.ts'
import {
  sessionFormatCatalog,
} from '../packages/session/session-format-catalog/src/generated.ts'
import {
  validateInstalledCurrentSessionArtifact,
} from '../packages/session/session-format-catalog/src/current.ts'
import {
  compressZstdFrame,
  createZstdFrameDecoder,
  scanZstdFrames,
} from '../packages/session/session-persistence-jsonl/src/zstd.ts'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  generationLogPath,
  type JsonlCompression,
} from '../packages/session/session-persistence-jsonl/src/format.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

/** Reproducible full-acceptance sampling specification. */
export const ACCEPTANCE_DEFAULTS = Object.freeze({
  runs: 3,
  warmups: 100,
  samples: 600,
  thresholdPercent: 5,
})

/** Short diagnostic sampling specification; it is not an acceptance result. */
export const SMOKE_DEFAULTS = Object.freeze({
  runs: 1,
  warmups: 3,
  samples: 20,
  thresholdPercent: 5,
})

interface BenchmarkOptions {
  readonly runs: number
  readonly warmups: number
  readonly samples: number
  readonly thresholdPercent: number
  readonly smoke: boolean
  readonly help: boolean
}

interface PhysicalInput {
  readonly header: unknown
  readonly rows: readonly unknown[]
}

interface PhysicalFixture {
  readonly raw: Buffer
  readonly zstd: Buffer
}

interface Fixture {
  readonly name: 'small' | '100-turn'
  readonly turns: number
  readonly v1: SessionFormatArtifact
  readonly v2: SessionFormatArtifact
  readonly v1Physical: PhysicalFixture
  readonly v2Physical: PhysicalFixture
}

interface CurrentReadCase {
  readonly label: string
  readonly root: string
  readonly id: SessionIdType
  readonly compression: JsonlCompression
  readonly physical: PhysicalInput
  readonly expected: SessionFormatArtifact
}

interface Distribution {
  readonly medianUs: number
  readonly p95Us: number
}

interface PairedResult {
  readonly direct: Distribution
  readonly catalog: Distribution
  readonly medianRegressionPercent: number
  readonly p95RegressionPercent: number
  readonly passed: boolean
}

type StoredRead = SessionFormatArtifact

interface EventExtras {
  readonly surfaceOp?: SessionFormatEvent['surfaceOp']
  readonly sourceEventSeqs?: SessionFormatEvent['sourceEventSeqs']
}

let resultSink = 0

/** Parse benchmark-only CLI options without mutating process-global state. */
export function parseOptions(argv: readonly string[]): BenchmarkOptions {
  const smoke = argv.includes('--smoke')
  const defaults = smoke ? SMOKE_DEFAULTS : ACCEPTANCE_DEFAULTS
  const values: {
    runs: number
    warmups: number
    samples: number
    thresholdPercent: number
  } = { ...defaults }
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string
    if (argument === '--smoke') continue
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    const match = /^--(runs|warmups|samples|threshold-percent)(?:=(.+))?$/.exec(argument)
    if (match === null) throw new Error(`unknown benchmark option ${JSON.stringify(argument)}`)
    const name = match[1]
    if (name === undefined) throw new Error(`unknown benchmark option ${JSON.stringify(argument)}`)
    const raw = match[2] ?? argv[index + 1]
    if (raw === undefined || (match[2] === undefined && raw.startsWith('--'))) {
      throw new Error(`${name} requires a numeric value`)
    }
    if (match[2] === undefined) index += 1
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`)
    }
    if (name !== 'warmups' && value === 0) throw new Error(`${name} must be positive`)
    switch (name) {
      case 'runs': values.runs = value; break
      case 'warmups': values.warmups = value; break
      case 'samples': values.samples = value; break
      case 'threshold-percent': values.thresholdPercent = value; break
    }
  }
  return { ...values, smoke, help }
}

/** Calculate the same discrete percentile used by the PR3 acceptance measurement. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error('percentile requires at least one sample')
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error('percentile fraction must be between zero and one')
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  selfCheckStatistics()

  const root = await mkdtemp(join(tmpdir(), 'dsh-v2-format-acceptance-'))
  try {
    const fixtures = await Promise.all([
      createFixture('small', 1),
      createFixture('100-turn', 100),
    ])
    const cases = await materializeCurrentReadCases(root, fixtures)
    await validateFixtureReads(cases)

    console.log('Session format v2 performance acceptance')
    console.log(
      'Direct-current/no-dispatch baseline: the released-v2 codec restores the same parsed physical rows. '
      + 'The candidate routes those rows through the static format catalog; public handles validate each file once.',
    )
    console.log(
      `Sampling: ${options.runs} run(s), ${options.warmups} warmup pair(s), `
      + `${options.samples} alternating measured pair(s), ${options.thresholdPercent}% median/p95 ceiling.`,
    )
    if (options.smoke) console.log('Mode: diagnostic smoke; timing ceiling is reported but not enforced.')
    console.log('')

    reportFixtureSizes(fixtures)
    console.log('')

    let accepted = true
    console.log('Current v2 physical decode and restoration (pooled hot samples)')
    for (const benchmarkCase of cases) {
      const result = runPairedCurrentRead(benchmarkCase, options)
      accepted &&= result.passed
      printPairedResult(benchmarkCase.label, result)
    }

    console.log('')
    console.log('Absolute costs (informational; no speedup claim)')
    for (const fixture of fixtures) {
      const migration = runDistribution(
        () => { consumeArtifact(sessionFormatV1ToV2.migrate(fixture.v1)) },
        options,
      )
      printDistribution(`${fixture.name} v1->v2 migration`, migration)

      const session = restoredSession(fixture.v2)
      const tokenMeter = runDistribution(
        () => { consumeMeasurement(measureWithFreshTokenMeter(session)) },
        options,
      )
      printDistribution(`${fixture.name} TokenMeter cold replay+measure`, tokenMeter)
    }

    console.log('')
    await reportMemory(fixtures, cases)
    const memory = process.memoryUsage()
    console.log(
      `process memory after run: heapUsed=${formatBytes(memory.heapUsed)}, `
      + `heapTotal=${formatBytes(memory.heapTotal)}, rss=${formatBytes(memory.rss)}`,
    )

    if (options.smoke) {
      console.log('')
      console.log('SMOKE COMPLETE (non-acceptance timing sample)')
    } else if (accepted) {
      console.log('')
      console.log('PASS: every pooled current-read median and p95 regression is within the 5% ceiling.')
    } else {
      console.error('')
      console.error('FAIL: at least one pooled current-read median or p95 regression exceeds the 5% ceiling.')
      process.exitCode = 1
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function printHelp(): void {
  console.log(`Usage: node --expose-gc --import tsx/esm ${process.argv[1] ?? '<benchmark>'} [options]

Options:
  --smoke                  Use 1 run, 3 warmups, and 20 samples; do not enforce timing.
  --runs N                 Independent runs (acceptance default: 3).
  --warmups N              Alternating warmup pairs per run (acceptance default: 100).
  --samples N              Alternating measured pairs per run (acceptance default: 600).
  --threshold-percent N    Median and p95 regression ceiling (acceptance default: 5).
  --help                   Show this help.`)
}

function selfCheckStatistics(): void {
  deepStrictEqual(parseOptions([]), { ...ACCEPTANCE_DEFAULTS, smoke: false, help: false })
  deepStrictEqual(parseOptions(['--smoke']), { ...SMOKE_DEFAULTS, smoke: true, help: false })
  deepStrictEqual(percentile([4, 1, 3, 2], 0.5), 3)
  deepStrictEqual(percentile([1, 2, 3, 4, 5], 0.95), 5)
}

async function createFixture(name: Fixture['name'], turns: number): Promise<Fixture> {
  const v1 = buildV1Artifact(name, turns)
  assertReleasedV1Artifact(v1)
  const v2 = sessionFormatV1ToV2.migrate(v1)
  assertReleasedV2Artifact(v2)
  validateInstalledCurrentSessionArtifact(v2)
  ok(v2.events.some(event => event.type === 'assistant/message'
    && Array.isArray((event.data as SessionFormatJsonObject)['stream'])
    && ((event.data as SessionFormatJsonObject)['stream'] as readonly unknown[]).length > 0))

  const v1Physical = await encodePhysical(releasedV1SessionFormatCodec.encodeArtifact(v1, { packChunks: true }))
  const v2Physical = await encodePhysical(releasedV2SessionFormatCodec.encodeArtifact(v2))
  const v1Decoded = releasedV1SessionFormatCodec.decodeArtifact(...physicalArguments(parseRaw(v1Physical.raw)))
  const v2Decoded = releasedV2SessionFormatCodec.decodeArtifact(...physicalArguments(parseRaw(v2Physical.raw)))
  deepStrictEqual(v1Decoded, v1)
  deepStrictEqual(v2Decoded, v2)
  deepStrictEqual(
    releasedV1SessionFormatCodec.decodeArtifact(...physicalArguments(parseZstd(v1Physical.zstd))),
    v1,
  )
  deepStrictEqual(
    releasedV2SessionFormatCodec.decodeArtifact(...physicalArguments(parseZstd(v2Physical.zstd))),
    v2,
  )
  return { name, turns, v1, v2, v1Physical, v2Physical }
}

function buildV1Artifact(name: string, turns: number): SessionFormatArtifact {
  const events: SessionFormatEvent[] = []
  const append = (
    type: string,
    time: number,
    data: SessionFormatEvent['data'],
    extras: EventExtras = {},
  ): number => {
    const seq = events.length
    events.push({ type, seq, time, data, ...extras })
    return seq
  }

  for (let turn = 1; turn <= turns; turn += 1) {
    const baseTime = turn * 1_000
    append('turn/start', baseTime, { turn })
    append('user/message', baseTime + 1, {
      id: `user-${name}-${turn}`,
      role: 'user',
      content: [{
        type: 'text',
        text: `Turn ${turn}: inspect the deterministic workspace report and explain the relevant changes clearly.`,
      }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    append('step/start', baseTime + 2, { turn, step: 1 })
    append('request/header', baseTime + 3, {
      header: {
        config: { provider: 'mock', model: 'benchmark-model', maxTokens: 2_048 },
        system: 'Answer with a concise explanation grounded in the supplied report.',
        tools: [],
      },
      reason: 'initial',
    })

    const reasoningParts = [
      `Turn ${turn} establishes the requested scope. `,
      'The durable facts are checked against the current session state. ',
      'The response keeps the relevant behavior and omits unrelated details. ',
      'The final wording records the observable result directly.',
    ]
    const textParts = [
      `For turn ${turn}, the report confirms the requested behavior. `,
      'The current state is internally consistent, ',
      'the persisted events retain their required ordering, ',
      'and the replayed message matches the provider stream. ',
      'No unrelated setting changes are included. ',
      'The result remains deterministic across repeated reads. ',
      'The validation path checks the complete artifact. ',
      'This completes the requested analysis.',
    ]
    const usage = {
      inputTokens: 800 + turn * 8,
      outputTokens: 160,
      totalTokens: 1_080 + turn * 8,
      cacheReadTokens: 120,
      cacheWriteTokens: 0,
      reasoningTokens: 56,
    }
    const chunkSeqs: number[] = []
    chunkSeqs.push(append('assistant/chunk', baseTime + 10, {
      turn, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
    }))
    for (const [index, text] of reasoningParts.entries()) {
      chunkSeqs.push(append('assistant/chunk', baseTime + 11 + index, {
        turn, step: 1, chunk: { type: 'reasoning-delta', index: 0, text },
      }))
    }
    chunkSeqs.push(append('assistant/chunk', baseTime + 15, {
      turn,
      step: 1,
      chunk: {
        type: 'block-end',
        index: 0,
        block: { type: 'reasoning', text: reasoningParts.join('') },
      },
    }))
    chunkSeqs.push(append('assistant/chunk', baseTime + 16, {
      turn, step: 1, chunk: { type: 'block-start', index: 1, blockType: 'text' },
    }))
    for (const [index, text] of textParts.entries()) {
      chunkSeqs.push(append('assistant/chunk', baseTime + 17 + index, {
        turn, step: 1, chunk: { type: 'text-delta', index: 1, text },
      }))
    }
    chunkSeqs.push(append('assistant/chunk', baseTime + 25, {
      turn,
      step: 1,
      chunk: { type: 'block-end', index: 1, block: { type: 'text', text: textParts.join('') } },
    }))
    chunkSeqs.push(append('assistant/chunk', baseTime + 26, {
      turn, step: 1, chunk: { type: 'usage', usage },
    }))
    chunkSeqs.push(append('assistant/chunk', baseTime + 27, {
      turn, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
    }))
    append('assistant/message', baseTime + 28, {
      turn,
      step: 1,
      message: {
        id: `assistant-${name}-${turn}`,
        role: 'assistant',
        content: [
          { type: 'reasoning', text: reasoningParts.join('') },
          { type: 'text', text: textParts.join('') },
        ],
        source: { kind: 'model', provider: 'mock', model: 'benchmark-model' },
      },
      usage,
    }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
    append('step/end', baseTime + 29, { turn, step: 1 })
    append('turn/end', baseTime + 30, { turn, reason: { kind: 'completed' } })
  }

  return snapshotSessionFormatArtifact({
    header: {
      version: 1,
      id: `v2-performance-${name}`,
      createdAt: 1,
      cwd: '/benchmark',
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'benchmark',
    },
    inheritedEventCount: 0,
    events,
  }, `${name} v1 benchmark artifact`)
}

async function encodePhysical(encoded: EncodedSessionFormatArtifact): Promise<PhysicalFixture> {
  const headerLine = `${JSON.stringify(encoded.header)}\n`
  const body = `${encoded.rows.map(row => JSON.stringify(row)).join('\n')}\n`
  const raw = Buffer.from(headerLine + body)
  const zstd = Buffer.concat([
    await compressZstdFrame(headerLine),
    await compressZstdFrame(body),
  ])
  return { raw, zstd }
}

async function materializeCurrentReadCases(
  root: string,
  fixtures: readonly Fixture[],
): Promise<readonly CurrentReadCase[]> {
  const cases: CurrentReadCase[] = []
  for (const fixture of fixtures) {
    for (const compression of ['none', 'zstd'] as const) {
      const caseRoot = join(root, `${fixture.name}-${compression}`)
      const id = SessionId(fixture.v2.header.id)
      const path = generationLogPath(caseRoot, fixture.v2.header.cwd, id, 2, compression)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, compression === 'none' ? fixture.v2Physical.raw : fixture.v2Physical.zstd)
      cases.push({
        label: `${compression === 'none' ? 'raw' : 'Zstandard'} ${fixture.name}`,
        root: caseRoot,
        id,
        compression,
        physical: compression === 'none'
          ? parseRaw(fixture.v2Physical.raw)
          : parseZstd(fixture.v2Physical.zstd),
        expected: fixture.v2,
      })
    }
  }
  return cases
}

async function validateFixtureReads(cases: readonly CurrentReadCase[]): Promise<void> {
  for (const benchmarkCase of cases) {
    const mounted = await mountBackend(benchmarkCase)
    try {
      const handle = await mounted.persistence.open(benchmarkCase.id, 'read')
      try {
        deepStrictEqual(handle.header, benchmarkCase.expected.header)
        deepStrictEqual(handle.inheritedEventCount, benchmarkCase.expected.inheritedEventCount)
        deepStrictEqual(await handle.read(), benchmarkCase.expected.events)
      } finally {
        await handle.close()
      }
      const direct = directCurrentRead(benchmarkCase)
      const catalog = catalogCurrentRead(benchmarkCase)
      deepStrictEqual(direct, benchmarkCase.expected)
      deepStrictEqual(catalog, direct)
    } finally {
      await mounted.dispose()
    }
  }
}

async function mountBackend(benchmarkCase: CurrentReadCase): Promise<{
  readonly persistence: SessionPersistence
  readonly dispose: () => Promise<void>
}> {
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, {
    root: benchmarkCase.root,
    compression: benchmarkCase.compression,
  })
  return {
    persistence: context.sessionPersistence,
    dispose: async () => context.fiber.dispose(),
  }
}

function directCurrentRead(benchmarkCase: CurrentReadCase): StoredRead {
  const decoded = snapshotSessionFormatArtifact(
    releasedV2SessionFormatCodec.decodeArtifact(
      benchmarkCase.physical.header,
      benchmarkCase.physical.rows,
    ),
    'direct released-v2 decoded artifact',
  )
  const source = snapshotSessionFormatArtifact(decoded, 'direct released-v2 source')
  const restored = restoreReleasedV2Artifact(source, KNOWN_SESSION_EVENT_TYPES)
  validateInstalledCurrentSessionArtifact(restored)
  return snapshotSessionFormatArtifact(restored, 'direct current Session restoration')
}

function catalogCurrentRead(benchmarkCase: CurrentReadCase): StoredRead {
  return sessionFormatCatalog.migrate(sessionFormatCatalog.decodeArtifact(
    benchmarkCase.physical.header,
    benchmarkCase.physical.rows,
  ))
}

function parseRaw(bytes: Buffer): PhysicalInput {
  return parseJsonl(bytes.toString('utf8'))
}

function parseZstd(bytes: Buffer): PhysicalInput {
  const scan = scanZstdFrames(bytes)
  if (scan.tornStart !== undefined || scan.frames.length !== 2) {
    throw new Error('benchmark Zstandard artifact must contain two complete frames')
  }
  const decoder = createZstdFrameDecoder()
  let text = ''
  for (const plaintext of decoder.decode(bytes, scan.frames)) text += plaintext.toString('utf8')
  return parseJsonl(text)
}

function parseJsonl(text: string): PhysicalInput {
  if (!text.endsWith('\n')) throw new Error('benchmark artifact lacks its final newline')
  const lines = text.slice(0, -1).split('\n')
  const header = JSON.parse(lines[0] as string) as unknown
  const rows = lines.slice(1).map(line => JSON.parse(line) as unknown)
  return { header, rows }
}

function physicalArguments(input: PhysicalInput): [unknown, readonly unknown[]] {
  return [input.header, input.rows]
}

function runPairedCurrentRead(
  benchmarkCase: CurrentReadCase,
  options: BenchmarkOptions,
): PairedResult {
  const pooledDirect: number[] = []
  const pooledCatalog: number[] = []
  for (let run = 0; run < options.runs; run += 1) {
    forceGc()
    for (let warmup = 0; warmup < options.warmups; warmup += 1) {
      if ((warmup + run) % 2 === 0) {
        consumeStored(directCurrentRead(benchmarkCase))
        consumeStored(catalogCurrentRead(benchmarkCase))
      } else {
        consumeStored(catalogCurrentRead(benchmarkCase))
        consumeStored(directCurrentRead(benchmarkCase))
      }
    }
    const direct: number[] = []
    const catalog: number[] = []
    for (let sample = 0; sample < options.samples; sample += 1) {
      if ((sample + run) % 2 === 0) {
        direct.push(timedUs(() => { consumeStored(directCurrentRead(benchmarkCase)) }))
        catalog.push(timedUs(() => { consumeStored(catalogCurrentRead(benchmarkCase)) }))
      } else {
        catalog.push(timedUs(() => { consumeStored(catalogCurrentRead(benchmarkCase)) }))
        direct.push(timedUs(() => { consumeStored(directCurrentRead(benchmarkCase)) }))
      }
    }
    pooledDirect.push(...direct)
    pooledCatalog.push(...catalog)
    const directRun = distribution(direct)
    const catalogRun = distribution(catalog)
    console.log(
      `  ${benchmarkCase.label} run ${run + 1}: direct ${formatDistribution(directRun)}; `
      + `catalog ${formatDistribution(catalogRun)}`,
    )
  }

  const direct = distribution(pooledDirect)
  const catalog = distribution(pooledCatalog)
  const medianRegressionPercent = percentChange(catalog.medianUs, direct.medianUs)
  const p95RegressionPercent = percentChange(catalog.p95Us, direct.p95Us)
  return {
    direct,
    catalog,
    medianRegressionPercent,
    p95RegressionPercent,
    passed: medianRegressionPercent <= options.thresholdPercent
      && p95RegressionPercent <= options.thresholdPercent,
  }
}

function runDistribution(operation: () => void, options: BenchmarkOptions): Distribution {
  const samples: number[] = []
  for (let run = 0; run < options.runs; run += 1) {
    forceGc()
    for (let warmup = 0; warmup < options.warmups; warmup += 1) operation()
    for (let sample = 0; sample < options.samples; sample += 1) samples.push(timedUs(operation))
  }
  return distribution(samples)
}

function distribution(samples: readonly number[]): Distribution {
  return { medianUs: percentile(samples, 0.5), p95Us: percentile(samples, 0.95) }
}

function timedUs(operation: () => void): number {
  const started = performance.now()
  operation()
  return (performance.now() - started) * 1_000
}

function consumeArtifact(artifact: SessionFormatArtifact): void {
  resultSink = (resultSink + artifact.events.length + artifact.header.version) | 0
}

function consumeStored(stored: StoredRead): void {
  resultSink = (resultSink + stored.events.length + stored.header.version) | 0
}

function consumeMeasurement(measurement: ReturnType<TokenMeter['measure']>): void {
  resultSink = (resultSink + measurement.totalTokens + measurement.nodes.length) | 0
}

function restoredSession(artifact: SessionFormatArtifact): Session {
  return Session.fromRestore(
    SessionId(artifact.header.id),
    artifact.events as SessionEvent[],
    artifact.header as unknown as SessionHeader,
    SessionLogOffset(artifact.inheritedEventCount),
  )
}

function measureWithFreshTokenMeter(session: Session): ReturnType<TokenMeter['measure']> {
  const context = new Context()
  new SessionProjectionRegistry(context)
  const meter = new TokenMeter(context)
  return meter.measure(session)
}

function reportFixtureSizes(fixtures: readonly Fixture[]): void {
  console.log('Logical and physical representation')
  for (const fixture of fixtures) {
    const eventReduction = reductionPercent(fixture.v2.events.length, fixture.v1.events.length)
    const rawReduction = reductionPercent(fixture.v2Physical.raw.length, fixture.v1Physical.raw.length)
    const zstdReduction = reductionPercent(fixture.v2Physical.zstd.length, fixture.v1Physical.zstd.length)
    console.log(
      `  ${fixture.name} (${fixture.turns} turn(s)): logical events ${fixture.v1.events.length} -> ${fixture.v2.events.length} `
      + `(${eventReduction.toFixed(3)}% fewer); raw ${formatBytes(fixture.v1Physical.raw.length)} -> `
      + `${formatBytes(fixture.v2Physical.raw.length)} (change ${formatSigned(-rawReduction)}%); `
      + `Zstandard ${formatBytes(fixture.v1Physical.zstd.length)} -> ${formatBytes(fixture.v2Physical.zstd.length)} `
      + `(change ${formatSigned(-zstdReduction)}%).`,
    )
  }
}

function printPairedResult(label: string, result: PairedResult): void {
  console.log(
    `  ${label} pooled: direct ${formatDistribution(result.direct)}; catalog ${formatDistribution(result.catalog)}; `
    + `regression median=${formatSigned(result.medianRegressionPercent)}%, `
    + `p95=${formatSigned(result.p95RegressionPercent)}% [${result.passed ? 'within ceiling' : 'exceeds ceiling'}]`,
  )
}

function printDistribution(label: string, result: Distribution): void {
  console.log(`  ${label}: ${formatDistribution(result)}`)
}

async function reportMemory(
  fixtures: readonly Fixture[],
  cases: readonly CurrentReadCase[],
): Promise<void> {
  console.log('Retained heap (informational; one forced-GC observation)')
  if (globalThis.gc === undefined) {
    console.log('  unavailable: rerun with --expose-gc for retained-heap observations')
    return
  }
  for (const fixture of fixtures) {
    const rawCase = cases.find(candidate => candidate.label === `raw ${fixture.name}`) as CurrentReadCase
    const direct = await retainedHeap(() => directCurrentRead(rawCase))
    const catalog = await retainedHeap(() => catalogCurrentRead(rawCase))
    const migration = await retainedHeap(() => sessionFormatV1ToV2.migrate(fixture.v1))
    const session = restoredSession(fixture.v2)
    const tokenMeter = await retainedHeap(() => measureWithFreshTokenMeter(session))
    console.log(
      `  ${fixture.name}: direct current=${formatSignedBytes(direct)}, `
      + `catalog current=${formatSignedBytes(catalog)}, migration=${formatSignedBytes(migration)}, `
      + `TokenMeter=${formatSignedBytes(tokenMeter)}`,
    )
  }
}

async function retainedHeap(operation: () => object | Promise<object>): Promise<number> {
  forceGc()
  const before = process.memoryUsage().heapUsed
  let retained: object | undefined = await operation()
  forceGc()
  const after = process.memoryUsage().heapUsed
  resultSink = (resultSink + Object.keys(retained).length) | 0
  retained = undefined
  forceGc()
  return after - before
}

function forceGc(): void {
  globalThis.gc?.()
}

function percentChange(value: number, baseline: number): number {
  return (value / baseline - 1) * 100
}

function reductionPercent(value: number, baseline: number): number {
  return (1 - value / baseline) * 100
}

function formatDistribution(value: Distribution): string {
  return `median=${value.medianUs.toFixed(3)} us p95=${value.p95Us.toFixed(3)} us`
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`
}

function formatBytes(value: number): string {
  if (Math.abs(value) < 1_024) return `${value} B`
  if (Math.abs(value) < 1_024 * 1_024) return `${(value / 1_024).toFixed(2)} KiB`
  return `${(value / (1_024 * 1_024)).toFixed(2)} MiB`
}

function formatSignedBytes(value: number): string {
  return `${value >= 0 ? '+' : '-'}${formatBytes(Math.abs(value))}`
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
