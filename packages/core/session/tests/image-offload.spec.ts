/**
 * Durable image offload watermark: append/seed validation, monotonic
 * advance, derived-surface marking, cache rebuild, and replay equality.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { compareImagePositions, foldImageOffloadWatermark, markImageOffload, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

function image(name: string): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: {
      attachmentId: `sha256:${'a'.repeat(64)}` as never,
      name,
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    },
  }
}

function toolResult(name: string): ContentBlock {
  return { type: 'tool-result', toolCallId: ToolCallId(name), content: [{ type: 'text', text: 'shot' }, image(name)] }
}

function seeded(): Session {
  const session = Session.create(SessionId('offload'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'no images here' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [image('first'), image('second')], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [toolResult('third'), image('fourth')], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session
}

function offloadedNames(session: Session): string[] {
  const names: string[] = []
  const visit = (content: readonly ContentBlock[]): void => {
    for (const block of content) {
      if (block.type === 'image' && block.offloaded === true) names.push(block.attachment.name ?? '')
      if (block.type === 'tool-result') visit(block.content)
    }
  }
  for (const message of session.deriveMessages()) {
    visit(message.content)
  }
  return names
}

describe('image/offload append validation', () => {
  it('rejects a malformed or out-of-range watermark', () => {
    const session = seeded()
    expect(() => session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(99), path: [0] } }))
      .toThrow('names an invalid image offload watermark')
    expect(() => session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [] } }))
      .toThrow('names an invalid image offload watermark')
    expect(() => session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [-1] } }))
      .toThrow('names an invalid image offload watermark')
    expect(() => session.append('image/offload', { turn: 1, step: 1, watermark: null as never }))
      .toThrow('names an invalid image offload watermark')
    expect(() => session.append('image/offload', 7 as never))
      .toThrow('names an invalid image offload watermark')
    expect(session.imageOffloadWatermark()).toBeUndefined()
  })

  it('requires the watermark path to identify a current surface image', () => {
    const session = seeded()
    expect(() => session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(2), path: [0] } }))
      .toThrow('watermark does not identify an image on the current surface')
    expect(() => session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [9] } }))
      .toThrow('watermark does not identify an image on the current surface')
    expect(() => session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [0, 0] } }))
      .toThrow('watermark does not identify an image on the current surface')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement' }], source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', start: SessionSeq(3), end: SessionSeq(3) },
      sourceEventSeqs: [SessionSeq(3)],
    })
    expect(() => session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [0] } }))
      .toThrow('watermark does not identify an image on the current surface')
  })

  it('rejects request-only offload markers from appended and restored messages', () => {
    const session = seeded()
    expect(() => session.append('user/message', createUserMessage({
      content: [{ ...image('marked'), offloaded: true }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }))
      .toThrow('stores the request-only image offload marker')

    const events = [...session.snapshotEvents()]
    const event = events[3]!
    const marked = {
      ...event,
      data: { ...event.data, content: [null, { ...image('restored-marked'), offloaded: true }] },
    }
    events[3] = marked as never
    expect(() => Session.create(SessionId('offload-marked-seed'), events))
      .toThrow('seed user/message at index 3 stores the request-only image offload marker')
  })

  it('accepts only strictly advancing positions', () => {
    const session = seeded()
    session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [1] } })
    expect(session.imageOffloadWatermark()).toEqual({ seq: 3, path: [1] })
    expect(() => session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [1] } }))
      .toThrow('does not advance the image offload watermark')
    expect(() => session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [0] } }))
      .toThrow('does not advance the image offload watermark')
    session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(4), path: [0, 1] } })
    expect(session.imageOffloadWatermark()).toEqual({ seq: 4, path: [0, 1] })
    expect(Object.isFrozen(session.imageOffloadWatermark())).toBe(true)
  })

  it('validates a seed with the same rules and folds its watermark', () => {
    const session = seeded()
    session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [0] } })
    const replayed = Session.create(SessionId('offload-replay'), session.snapshotEvents())
    expect(replayed.imageOffloadWatermark()).toEqual({ seq: 3, path: [0] })
    expect(replayed.deriveMessages()).toEqual(session.deriveMessages())

    const events = session.snapshotEvents().map(event => (
      event.type === 'image/offload'
        ? { ...event, data: { ...event.data, watermark: { seq: 50, path: [0] } } }
        : event
    ))
    expect(() => Session.create(SessionId('offload-bad-seed'), events as never))
      .toThrow('seed event at index 5 names an invalid image offload watermark')
  })
})

describe('image/offload surface derivation', () => {
  it('marks occurrences at or before the watermark, including nested tool results', () => {
    const session = seeded()
    expect(offloadedNames(session)).toEqual([])
    session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [0] } })
    expect(offloadedNames(session)).toEqual(['first'])
    session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(4), path: [0, 1] } })
    expect(offloadedNames(session)).toEqual(['first', 'second', 'third'])
    session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(4), path: [1] } })
    expect(offloadedNames(session)).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('marks images below two nested tool-result levels', () => {
    const session = seeded()
    const deep = session.append('user/message', createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId('outer'),
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('middle'),
          content: [{ type: 'tool-result', toolCallId: ToolCallId('inner'), content: [image('deep')] }],
        }],
      }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('image/offload', {
      turn: 1,
      step: 1,
      watermark: { seq: deep.seq, path: [0, 0, 0, 0] },
    })
    expect(offloadedNames(session)).toContain('deep')
  })

  it('freezes marked copies, keeps the durable event content untouched, and matches a scratch replay', () => {
    const session = seeded()
    const before = session.deriveMessages()
    session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [0] } })
    const after = session.deriveMessages()
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(Object.isFrozen(after[1])).toBe(true)
    expect(Object.isFrozen(after[1]!.content[0])).toBe(true)
    expect(after[2]).toBe(before[2])
    expect(before[1]!.content[0]).toEqual(image('first'))
    expect(session.eventAt(SessionSeq(3))!.data).toMatchObject({ content: [image('first'), image('second')] })
    const scratch = Session.create(SessionId('offload-scratch'), session.snapshotEvents())
    expect(scratch.deriveMessages()).toEqual(after)
  })

  it('leaves later appended nodes retained without rebuilding the cache', () => {
    const session = seeded()
    session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(4), path: [1] } })
    const marked = session.deriveMessages()
    session.append('user/message', createUserMessage({
      content: [image('fifth')], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const grown = session.deriveMessages()
    expect(grown[0]).toBe(marked[0])
    expect(grown.at(-1)!.content[0]).toEqual(image('fifth'))
    expect(offloadedNames(session)).toEqual(['first', 'second', 'third', 'fourth'])
  })
})

describe('image offload helpers', () => {
  it('preserves a nested block when only an earlier sibling is offloaded', () => {
    const message = createUserMessage({
      content: [image('first'), toolResult('later')],
      source: { kind: 'user' },
    })
    const projected = markImageOffload(message, SessionSeq(3), { seq: SessionSeq(3), path: [0] })
    expect(projected.content[0]).toEqual({ ...image('first'), offloaded: true })
    expect(projected.content[1]).toBe(message.content[1])
  })

  it('orders positions by seq then path and folds the latest watermark', () => {
    expect(compareImagePositions({ seq: SessionSeq(1), path: [5] }, { seq: SessionSeq(3), path: [0] })).toBeLessThan(0)
    expect(compareImagePositions({ seq: SessionSeq(4), path: [1] }, { seq: SessionSeq(3), path: [0, 3] })).toBeGreaterThan(0)
    const session = seeded()
    expect(foldImageOffloadWatermark(session.snapshotEvents())).toBeUndefined()
    session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(3), path: [0] } })
    const prior = foldImageOffloadWatermark(session.snapshotEvents())
    expect(prior).toEqual({ seq: 3, path: [0] })
    session.append('image/offload', { turn: 1, step: 1, watermark: { seq: SessionSeq(4), path: [1] } })
    expect(foldImageOffloadWatermark(session.snapshotEvents().slice(6), prior)).toEqual({ seq: 4, path: [1] })
    expect(foldImageOffloadWatermark([], prior)).toEqual(prior)
  })
})
