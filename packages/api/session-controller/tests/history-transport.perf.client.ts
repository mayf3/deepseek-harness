/** Opt-in synthetic benchmark for packed session-history transport and exact replay. */

import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { HistoryEntry, HistoryRecord } from '@deepseek-ai/dsh-api-remotes/client'
import { isChunkRow, packChunkRuns } from '@deepseek-ai/dsh-session/chunk-rows'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session/types'
import {
  historyEntrySchema,
  sessionHistoryValueSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/sessions.schema'
import type {
  ConversationEventInput,
  ConversationNodeDefinition,
  ConversationViewDefinition,
  ConversationViewNode,
} from '../src/client/contract/conversation.ts'
import { ConversationNodeAssembler } from '../src/client/sessions/conversation-assembler.ts'
import { historyEntries } from '../src/client/sessions/history-records.ts'

const LOGICAL_EVENTS = 416_756
const DELTA_EVENTS = 416_176
const ORDINARY_EVENTS = LOGICAL_EVENTS - DELTA_EVENTS
const DELTA_RUNS = 116
const TIME_ZERO = 1_700_000_000_000

interface Timed<T> {
  readonly value: T
  readonly ms: number
}

interface HeapPeaks<T> {
  readonly value: T
  readonly medianPeakBytes: number
  readonly peakBytes: readonly number[]
}

interface FoldState {
  readonly blocks: readonly string[]
  readonly deltaCount: number
  readonly lastDeltaSeq?: number
  readonly firstTokenTime?: number
  readonly firstVisibleSeq?: number
  readonly firstVisibleTime?: number
}

interface FoldSnapshots {
  readonly chat: unknown
  readonly trajectory: unknown
}

interface RawHistoryValue {
  readonly events: HistoryEntry[]
  readonly hasMore: boolean
}

interface PackedHistoryValue {
  readonly records: HistoryRecord[]
  readonly hasMore: boolean
  readonly fromSeq: number
  readonly toSeq: number
}

function timed<T>(run: () => T): Timed<T> {
  const start = performance.now()
  const value = run()
  return { value, ms: performance.now() - start }
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

function reduction(before: number, after: number): number {
  return rounded((1 - after / before) * 100)
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.floor(ordered.length / 2)]!
}

/** Measure caller-sampled additional V8 heap from forced-GC baselines. */
function sampledPeakHeap<T>(run: (sample: () => void) => T): HeapPeaks<T> {
  const forceGc = globalThis.gc
  if (forceGc === undefined) {
    throw new Error('history transport memory benchmark requires Vitest worker --expose-gc')
  }
  const samples = Array.from({ length: 3 }, () => {
    forceGc()
    forceGc()
    const baseline = process.memoryUsage().heapUsed
    let peak = baseline
    const sample = (): void => {
      peak = Math.max(peak, process.memoryUsage().heapUsed)
    }
    const value = run(sample)
    sample()
    return { value, peakBytes: peak - baseline }
  })
  return {
    value: samples[0]!.value,
    medianPeakBytes: median(samples.map(sample => sample.peakBytes)),
    peakBytes: samples.map(sample => sample.peakBytes),
  }
}

function append<Type extends keyof SessionEventMap>(
  events: SessionEvent[],
  type: Type,
  data: SessionEventMap[Type],
  options: { readonly surfaceOp?: 'append'; readonly ignorable?: true } = {},
): void {
  const seq = events.length
  events.push({ type, seq, time: TIME_ZERO + seq, data, ...options } as SessionEvent<Type>)
}

function appendSeparator(events: SessionEvent[], run: number, separator: number): void {
  const seq = events.length
  events.push({
    type: 'benchmark/separator',
    seq,
    time: TIME_ZERO + seq,
    data: { run, separator },
    ignorable: true,
  } as SessionEvent)
}

function fragment(run: number, index: number): string {
  const value = (Math.imul(run + 1, 0x9E3779B1) ^ Math.imul(index + 1, 0x85EBCA6B)) >>> 0
  return value.toString(36).padStart(7, '0').slice(-2)
}

/** Build the private sample's event/run cardinality from deterministic synthetic content. */
function buildEvents(): SessionEvent[] {
  const events: SessionEvent[] = []
  append(events, 'turn/start', { turn: 1 })
  append(events, 'user/message', createUserMessage({
    content: [{ type: 'text', text: 'synthetic history transport benchmark' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  append(events, 'step/start', { turn: 1, step: 1 })

  const baseRunLength = Math.floor(DELTA_EVENTS / DELTA_RUNS)
  const longerRuns = DELTA_EVENTS % DELTA_RUNS
  for (let run = 0; run < DELTA_RUNS; run++) {
    const runLength = baseRunLength + (run < longerRuns ? 1 : 0)
    for (let index = 0; index < runLength; index++) {
      append(events, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: {
          type: 'reasoning-delta',
          index: run,
          text: fragment(run, index),
        },
      })
    }
    const separators = run < 3 ? 4 : 5
    for (let separator = 0; separator < separators; separator++) {
      appendSeparator(events, run, separator)
    }
  }
  return events
}

function foldDefinition(kind: string, target: string): ConversationNodeDefinition<FoldState> {
  return {
    kind,
    target,
    match: (event) => {
      if (event.type === 'step/start') return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'start' }
      if (event.type === 'assistant/chunk' && event.data.chunk.type === 'reasoning-delta') {
        return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'update' }
      }
      return null
    },
    start: () => ({ blocks: [], deltaCount: 0 }),
    update: (context, match) => {
      if (match.event.type !== 'assistant/chunk' || match.event.data.chunk.type !== 'reasoning-delta') {
        return context.state
      }
      const chunk = match.event.data.chunk
      const blocks = [...context.state.blocks]
      blocks[chunk.index] = (blocks[chunk.index] ?? '') + chunk.text
      const visible = blocks.some(block => block.trim() !== '')
      return {
        ...context.state,
        blocks,
        deltaCount: context.state.deltaCount + 1,
        lastDeltaSeq: match.event.seq,
        ...context.state.firstTokenTime === undefined ? { firstTokenTime: match.event.time } : {},
        ...visible && context.state.firstVisibleSeq === undefined
          ? { firstVisibleSeq: match.event.seq, firstVisibleTime: match.event.time }
          : {},
      }
    },
    buildViewNode: context => context.state === undefined
      ? null
      : {
        key: context.key,
        kind: context.kind,
        id: context.id,
        target,
        data: context.state,
      },
  }
}

function viewDefinition(target: string): ConversationViewDefinition<ConversationViewNode, readonly ConversationViewNode[]> {
  return {
    target,
    create: () => ({
      empty: [],
      replace: ({ nodes }) => nodes,
      apply: ({ upserts }) => upserts,
    }),
  }
}

function conversationInputs(entries: readonly HistoryEntry[]): ConversationEventInput[] {
  return entries.map(entry => ({ event: entry.event, view: entry.view }))
}

function assemble(entries: readonly ConversationEventInput[]): FoldSnapshots {
  const definitions = [
    foldDefinition('benchmark-chat-assistant', 'chat'),
    foldDefinition('benchmark-trajectory-assistant', 'trajectory'),
  ]
  const assembler = new ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [viewDefinition('chat'), viewDefinition('trajectory')] },
  )
  assembler.replaceWindow(entries, false)
  assembler.flush()
  return {
    chat: assembler.snapshot('chat'),
    trajectory: assembler.snapshot('trajectory'),
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

it('reports packed history transport and exact replay costs', () => {
  const fixture = timed(buildEvents)

  assemble(conversationInputs(fixture.value.slice(0, 1_000).map(event => ({ event }))))
  const rawHostHeap = sampledPeakHeap((sample) => {
    const entries = fixture.value.map(event => ({ event }))
    sample()
    const json = JSON.stringify({ events: entries, hasMore: false } satisfies RawHistoryValue)
    sample()
    return Buffer.byteLength(json)
  })
  const packedHostHeap = sampledPeakHeap((sample) => {
    const packedEvents = packChunkRuns(fixture.value)
    sample()
    const records = packedEvents.map((record): HistoryRecord =>
      isChunkRow(record) ? { chunks: record } : { event: record })
    sample()
    const json = JSON.stringify({
      records,
      hasMore: false,
      fromSeq: 0,
      toSeq: fixture.value.length,
    } satisfies PackedHistoryValue)
    sample()
    return Buffer.byteLength(json)
  })

  const rawEntries = timed(() => fixture.value.map(event => ({ event })))
  const packed = timed(() => packChunkRuns(fixture.value))
  const packedRecords = timed(() => packed.value.map((record): HistoryRecord =>
    isChunkRow(record) ? { chunks: record } : { event: record }))
  const rawValue: RawHistoryValue = { events: rawEntries.value, hasMore: false }
  const packedValue: PackedHistoryValue = {
    records: packedRecords.value,
    hasMore: false,
    fromSeq: 0,
    toSeq: fixture.value.length,
  }

  const rawJson = timed(() => JSON.stringify(rawValue))
  const packedJson = timed(() => JSON.stringify(packedValue))
  const rawGzip = timed(() => gzipSync(rawJson.value).byteLength)
  const packedGzip = timed(() => gzipSync(packedJson.value).byteLength)
  const rawBrotli = timed(() => brotliCompressSync(rawJson.value).byteLength)
  const packedBrotli = timed(() => brotliCompressSync(packedJson.value).byteLength)

  const rawClientHeap = sampledPeakHeap((sample) => {
    const parsed = JSON.parse(rawJson.value) as RawHistoryValue
    sample()
    for (const entry of parsed.events) historyEntrySchema.parse(entry)
    sample()
    const prepared = conversationInputs(parsed.events)
    sample()
    const folded = assemble(prepared)
    sample()
    return digest(folded)
  })
  const packedClientHeap = sampledPeakHeap((sample) => {
    const parsed = JSON.parse(packedJson.value) as PackedHistoryValue
    sample()
    sessionHistoryValueSchema.parse(parsed)
    sample()
    const prepared = conversationInputs(historyEntries(parsed.records))
    sample()
    const folded = assemble(prepared)
    sample()
    return digest(folded)
  })

  const parsedRaw = timed(() => JSON.parse(rawJson.value) as RawHistoryValue)
  const parsedPacked = timed(() => JSON.parse(packedJson.value) as PackedHistoryValue)
  const rawValidation = timed(() => {
    for (const entry of parsedRaw.value.events) historyEntrySchema.parse(entry)
  })
  const packedValidation = timed(() => sessionHistoryValueSchema.parse(parsedPacked.value))
  const rawPreparation = timed(() => conversationInputs(parsedRaw.value.events))
  const packedPreparation = timed(() => conversationInputs(historyEntries(parsedPacked.value.records)))

  assemble(rawPreparation.value.slice(0, 1_000))
  assemble(packedPreparation.value)
  const rawFold = timed(() => assemble(rawPreparation.value))
  const packedFold = timed(() => assemble(packedPreparation.value))

  const rawBytes = Buffer.byteLength(rawJson.value)
  const packedBytes = Buffer.byteLength(packedJson.value)
  const packedRows = packed.value.filter(isChunkRow)
  expect(fixture.value).toHaveLength(LOGICAL_EVENTS)
  expect(fixture.value.filter(event => event.type !== 'assistant/chunk')).toHaveLength(ORDINARY_EVENTS)
  expect(packedRows).toHaveLength(DELTA_RUNS)
  expect(packed.value).toHaveLength(696)
  expect(packedPreparation.value).toHaveLength(LOGICAL_EVENTS)
  expect(digest(packedFold.value)).toBe(digest(rawFold.value))
  expect(packedClientHeap.value).toBe(rawClientHeap.value)
  expect(rawHostHeap.value).toBe(rawBytes)
  expect(packedHostHeap.value).toBe(packedBytes)
  expect(packedBytes).toBeLessThan(rawBytes)

  const rawResponseMs = rawEntries.ms + rawJson.ms
  const packedResponseMs = packed.ms + packedRecords.ms + packedJson.ms
  const rawClientMs = parsedRaw.ms + rawValidation.ms + rawPreparation.ms + rawFold.ms
  const packedClientMs = parsedPacked.ms + packedValidation.ms + packedPreparation.ms + packedFold.ms
  process.stdout.write(`HISTORY_TRANSPORT_PERF_RESULT ${JSON.stringify({
    fixture: {
      buildMs: rounded(fixture.ms),
      logicalEvents: fixture.value.length,
      ordinaryEvents: ORDINARY_EVENTS,
      deltaEvents: DELTA_EVENTS,
      deltaRuns: packedRows.length,
      packedRecords: packed.value.length,
      decodedEvents: packedPreparation.value.length,
    },
    bytes: {
      rawJson: rawBytes,
      packedJson: packedBytes,
      jsonReductionPct: reduction(rawBytes, packedBytes),
      rawGzip: rawGzip.value,
      packedGzip: packedGzip.value,
      gzipReductionPct: reduction(rawGzip.value, packedGzip.value),
      rawBrotli: rawBrotli.value,
      packedBrotli: packedBrotli.value,
      brotliReductionPct: reduction(rawBrotli.value, packedBrotli.value),
    },
    memory: {
      samples: 3,
      rawHostAdditionalHeapPeakBytes: rawHostHeap.medianPeakBytes,
      packedHostAdditionalHeapPeakBytes: packedHostHeap.medianPeakBytes,
      hostReductionPct: reduction(rawHostHeap.medianPeakBytes, packedHostHeap.medianPeakBytes),
      rawClientAdditionalHeapPeakBytes: rawClientHeap.medianPeakBytes,
      packedClientAdditionalHeapPeakBytes: packedClientHeap.medianPeakBytes,
      clientReductionPct: reduction(rawClientHeap.medianPeakBytes, packedClientHeap.medianPeakBytes),
      rawHostPeakSamples: rawHostHeap.peakBytes,
      packedHostPeakSamples: packedHostHeap.peakBytes,
      rawClientPeakSamples: rawClientHeap.peakBytes,
      packedClientPeakSamples: packedClientHeap.peakBytes,
    },
    host: {
      rawEntryWrapMs: rounded(rawEntries.ms),
      packMs: rounded(packed.ms),
      packedRecordWrapMs: rounded(packedRecords.ms),
      rawStringifyMs: rounded(rawJson.ms),
      packedStringifyMs: rounded(packedJson.ms),
      rawGzipMs: rounded(rawGzip.ms),
      packedGzipMs: rounded(packedGzip.ms),
      rawBrotliMs: rounded(rawBrotli.ms),
      packedBrotliMs: rounded(packedBrotli.ms),
      rawResponseMs: rounded(rawResponseMs),
      packedResponseMs: rounded(packedResponseMs),
      responseReductionPct: reduction(rawResponseMs, packedResponseMs),
    },
    client: {
      rawParseMs: rounded(parsedRaw.ms),
      packedParseMs: rounded(parsedPacked.ms),
      rawValidationMs: rounded(rawValidation.ms),
      packedValidationMs: rounded(packedValidation.ms),
      rawPrepareMs: rounded(rawPreparation.ms),
      packedPrepareMs: rounded(packedPreparation.ms),
      rawFoldMs: rounded(rawFold.ms),
      packedFoldMs: rounded(packedFold.ms),
      rawHistoryMs: rounded(rawClientMs),
      packedHistoryMs: rounded(packedClientMs),
      historyReductionPct: reduction(rawClientMs, packedClientMs),
    },
  })}\n`)
}, 600_000)

it('reports exact decoding cost for long whitespace-prefix runs', () => {
  historyEntries([{
    chunks: {
      type: 'reasoning-chunks',
      seq0: 0,
      time0: TIME_ZERO,
      data: { turn: 1, step: 1, index: 0, dt: [], texts: ['x'] },
    },
  }])
  const results = [10_000, 20_000, 40_000].map((members) => {
    const record: HistoryRecord = {
      chunks: {
        type: 'reasoning-chunks',
        seq0: 0,
        time0: TIME_ZERO,
        data: {
          turn: 1,
          step: 1,
          index: 0,
          dt: Array.from({ length: members - 1 }, () => 1),
          texts: Array.from({ length: members }, (_, index) => index === members - 1 ? 'x' : ' '),
        },
      },
    }
    const decoded = historyEntries([record])
    const samplesMs = Array.from({ length: 5 }, () => timed(() => historyEntries([record])).ms)
    expect(decoded).toHaveLength(members)
    expect(decoded.at(-1)?.event).toMatchObject({
      seq: members - 1,
      time: TIME_ZERO + members - 1,
      data: { chunk: { type: 'reasoning-delta', text: 'x' } },
    })
    return {
      members,
      medianMs: rounded(median(samplesMs)),
      samplesMs: samplesMs.map(rounded),
    }
  })
  process.stdout.write(`HISTORY_WHITESPACE_PREFIX_PERF_RESULT ${JSON.stringify(results)}\n`)
})
