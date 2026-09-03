import { describe, expect, it } from 'vitest'
import { LlmAttemptId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
} from '../src/types.ts'
import { ClientAssistantStream } from '../src/client/sessions/assistant-stream.ts'
import type { SessionLiveEventEntry } from '../src/client/contract/events.ts'

const ATTEMPT = LlmAttemptId('session:1')

function entry(event: SessionEvent): SessionLiveEventEntry {
  return { type: 'event', event }
}

function ordinary(seq: number): SessionLiveEventEntry {
  return entry({ type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn: 1 } })
}

function chunk(seq: number, turn = 1, step = 1): SessionLiveEventEntry {
  return entry({
    type: 'assistant/chunk',
    seq: SessionSeq(seq),
    time: seq,
    data: { turn, step, chunk: { type: 'text-delta', index: 0, text: `chunk-${seq}` } },
  })
}

function message(
  seq: number,
  sourceEventSeqs: readonly number[] | undefined,
  turn = 1,
  step = 1,
  surfaceOp: 'append' | { readonly op: 'replace'; readonly start: number; readonly end: number } = 'append',
): SessionLiveEventEntry {
  return entry({
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      turn,
      step,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'done' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    },
    surfaceOp: surfaceOp === 'append'
      ? surfaceOp
      : { ...surfaceOp, start: SessionSeq(surfaceOp.start), end: SessionSeq(surfaceOp.end) },
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs: sourceEventSeqs.map(SessionSeq) }),
  })
}

function start(attemptId = ATTEMPT): SessionAssistantStreamFrame {
  return { type: 'start', attemptId, revision: 1, turn: 1, step: 1 }
}

function chunkFrame(
  index: number,
  legacyChunkSeq: number,
  attemptId = ATTEMPT,
): SessionAssistantStreamFrame {
  return {
    type: 'chunk',
    attemptId,
    revision: index + 2,
    index,
    chunk: { type: 'text-delta', index: 0, text: `chunk-${legacyChunkSeq}` },
    legacyChunkSeq,
  }
}

function end(
  outcome: 'committed' | 'aborted',
  index: number,
  legacyChunkSeqs: readonly number[],
  attemptId = ATTEMPT,
): SessionAssistantStreamFrame {
  return { type: 'end', attemptId, revision: index + 2, index, outcome, legacyChunkSeqs }
}

function baseline(
  chunks: SessionAssistantStreamBaseline['attempts'][number]['chunks'] = [],
  legacyChunkSeqs: readonly number[] = [],
): SessionAssistantStreamBaseline {
  return {
    revision: chunks.length + 1,
    attempts: [{ attemptId: ATTEMPT, turn: 1, step: 1, chunks, legacyChunkSeqs }],
  }
}

describe('ClientAssistantStream', () => {
  it('passes through ordinary and unowned durable events and adopts a baseline', () => {
    const stream = new ClientAssistantStream()
    const opening = ordinary(0)
    const window = [opening]
    expect(stream.replace(window)).toBe(window)

    stream.replace([], baseline([{ type: 'text-delta', index: 0, text: 'old' }], [5]))
    const represented = chunk(5)
    expect(stream.acceptDurable(represented)).toEqual({ type: 'publish', entry: represented })

    const unknownChunk = chunk(6, 2, 1)
    expect(stream.acceptDurable(unknownChunk)).toEqual({ type: 'publish', entry: unknownChunk })
    const replacement = message(7, [5], 1, 1, { op: 'replace', start: 0, end: 0 })
    expect(stream.acceptDurable(replacement)).toEqual({ type: 'publish', entry: replacement })
    const unknownMessage = message(8, [6], 2, 1)
    expect(stream.acceptDurable(unknownMessage)).toEqual({ type: 'publish', entry: unknownMessage })
    const turn = ordinary(9)
    expect(stream.acceptDurable(turn)).toEqual({ type: 'publish', entry: turn })
  })

  it('stages owned durable chunks and messages until their matching frames', () => {
    const stream = new ClientAssistantStream()
    stream.replace([])
    expect(stream.acceptFrame(start())).toBeUndefined()

    const durableChunk = chunk(2)
    expect(stream.acceptDurable(durableChunk)).toBeUndefined()
    expect(stream.acceptFrame(chunkFrame(0, 2))).toEqual({ type: 'publish', entry: durableChunk })

    const durableMessage = message(3, [2])
    expect(stream.acceptDurable(durableMessage)).toBeUndefined()
    expect(stream.acceptFrame(end('committed', 1, [2]))).toEqual({ type: 'publish', entry: durableMessage })
  })

  it('requests a new baseline for duplicate staged durable identities', () => {
    const chunks = new ClientAssistantStream()
    chunks.acceptFrame(start())
    expect(chunks.acceptDurable(chunk(2))).toBeUndefined()
    expect(chunks.acceptDurable(chunk(2))).toEqual({ type: 'rebaseline' })

    const messages = new ClientAssistantStream()
    messages.acceptFrame(start())
    expect(messages.acceptDurable(message(3, []))).toBeUndefined()
    expect(messages.acceptDurable(message(4, []))).toEqual({ type: 'rebaseline' })
  })

  it('falls back to durable publication for frames from an unknown attempt', () => {
    const stream = new ClientAssistantStream()
    const unknown = LlmAttemptId('session:unknown')

    expect(stream.acceptFrame(chunkFrame(0, 2, unknown))).toBeUndefined()
    expect(stream.acceptFrame(end('committed', 0, [], unknown))).toBeUndefined()
    const durableChunk = chunk(2)
    expect(stream.acceptDurable(durableChunk)).toEqual({ type: 'publish', entry: durableChunk })
  })

  it('rebaselines known attempts on chunk index or publication-order mismatch', () => {
    const wrongIndex = new ClientAssistantStream()
    wrongIndex.acceptFrame(start())
    expect(wrongIndex.acceptFrame(chunkFrame(1, 2))).toEqual({ type: 'rebaseline' })

    const frameFirst = new ClientAssistantStream()
    frameFirst.acceptFrame(start())
    expect(frameFirst.acceptFrame(chunkFrame(0, 2))).toEqual({ type: 'rebaseline' })

    const alreadyPublished = new ClientAssistantStream()
    alreadyPublished.replace([chunk(2)], baseline())
    expect(alreadyPublished.acceptFrame(chunkFrame(0, 2))).toBeUndefined()
  })

  it('rebaselines a known terminal frame with inconsistent index or chunk provenance', () => {
    const wrongIndex = new ClientAssistantStream()
    wrongIndex.acceptFrame(start())
    expect(wrongIndex.acceptFrame(end('committed', 1, []))).toEqual({ type: 'rebaseline' })

    const wrongLength = new ClientAssistantStream()
    wrongLength.acceptFrame(start())
    wrongLength.acceptDurable(chunk(2))
    expect(wrongLength.acceptFrame(chunkFrame(0, 2))).toEqual({ type: 'publish', entry: chunk(2) })
    expect(wrongLength.acceptFrame(end('committed', 1, []))).toEqual({ type: 'rebaseline' })

    const wrongMember = new ClientAssistantStream()
    wrongMember.acceptFrame(start())
    const durable = chunk(2)
    wrongMember.acceptDurable(durable)
    wrongMember.acceptFrame(chunkFrame(0, 2))
    expect(wrongMember.acceptFrame(end('committed', 1, [3]))).toEqual({ type: 'rebaseline' })
  })

  it('settles committed and aborted attempts against staged assistant messages', () => {
    const missingCommitted = new ClientAssistantStream()
    missingCommitted.acceptFrame(start())
    expect(missingCommitted.acceptFrame(end('committed', 0, []))).toEqual({ type: 'rebaseline' })

    const emptyAborted = new ClientAssistantStream()
    emptyAborted.acceptFrame(start())
    expect(emptyAborted.acceptFrame(end('aborted', 0, []))).toBeUndefined()

    const stagedAborted = new ClientAssistantStream()
    stagedAborted.acceptFrame(start())
    const interrupted = message(3, [])
    stagedAborted.acceptDurable(interrupted)
    expect(stagedAborted.acceptFrame(end('aborted', 0, [])))
      .toEqual({ type: 'publish', entry: interrupted })

    const missingSources = new ClientAssistantStream()
    missingSources.acceptFrame(start())
    missingSources.acceptDurable(message(3, undefined))
    expect(missingSources.acceptFrame(end('committed', 0, []))).toEqual({ type: 'rebaseline' })

    const mismatchedSources = new ClientAssistantStream()
    mismatchedSources.acceptFrame(start())
    mismatchedSources.acceptDurable(message(3, [7]))
    expect(mismatchedSources.acceptFrame(end('committed', 0, []))).toEqual({ type: 'rebaseline' })
  })
})
