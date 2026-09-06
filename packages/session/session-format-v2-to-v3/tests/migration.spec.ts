import { describe, expect, it, vi } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedV3Header,
  releasedV2SessionFormatCodec,
  releasedV3SessionFormatCodec,
  restoreReleasedV3Artifact,
  sessionFormatV2ToV3,
} from '../src/index.ts'

const header: SessionFormatHeader = {
  version: 2, id: 'identity', createdAt: 1, isSeeded: false, delegationDepth: 0,
}

describe('v2 to v3 identity migration', () => {
  it('changes only the header version and forwards events and runs without expansion', () => {
    const target = sessionFormatV2ToV3.migrateHeader(header)
    expect(target).toEqual({ ...header, version: 3 })
    expect(header.version).toBe(2)
    const stage = sessionFormatV2ToV3.createStage({
      sourceHeader: header, targetHeader: target, sourceInheritedEventCount: 0, sourceKind: 'decoded',
    })
    const event: SessionFormatEvent = {
      type: 'external/event', seq: 5, time: 12, data: { nested: ['payload'] },
      ignorable: true, sourceEventSeqs: [1, 2], surfaceOp: { replace: [3] },
    }
    const run = { runType: 'opaque', firstSeq: 6, eventCount: 2, expand: vi.fn() }
    const context = { emitEvent: vi.fn(), emitRun: vi.fn() }
    stage.transformEvent(event, context)
    stage.transformRun(run, context)
    expect(context.emitEvent.mock.calls[0]?.[0]).toBe(event)
    expect(context.emitRun.mock.calls[0]?.[0]).toBe(run)
    expect(run.expand).not.toHaveBeenCalled()
    expect(stage.finish(context)).toBe(0)
  })

  it('derives the inherited cut from scalar end-seed markers', () => {
    const seeded = { ...header, isSeeded: true }
    const stage = sessionFormatV2ToV3.createStage({
      sourceHeader: seeded, targetHeader: { ...seeded, version: 3 },
      sourceInheritedEventCount: undefined, sourceKind: 'transformed',
    })
    const context = new SessionFormatEventCollector()
    for (const data of [null, false, [], {}, { inherited: true }]) {
      stage.transformEvent({ type: 'session/end-seed', seq: 4, time: 1, data }, context)
    }
    expect(stage.finish(context)).toBe(4)
  })

  it('rejects missing, mismatched, and unseeded inherited cuts', () => {
    const context = new SessionFormatEventCollector()
    for (const [isSeeded, sourceCut, marker] of [[true, undefined, undefined], [true, 2, 1], [false, undefined, 1]] as const) {
      const source = { ...header, isSeeded }
      const stage = sessionFormatV2ToV3.createStage({
        sourceHeader: source, targetHeader: { ...source, version: 3 },
        sourceInheritedEventCount: sourceCut, sourceKind: 'decoded',
      })
      if (marker !== undefined) stage.transformEvent({
        type: 'session/end-seed', seq: marker, time: 1, data: { inherited: true },
      }, context)
      expect(() => stage.finish(context)).toThrow(/inherited/)
    }
  })

  it('round-trips v3 records with identical v2 provenance encoding', () => {
    const current = { ...header, version: 3 }
    const event = { type: 'external/event', seq: 3, time: 1, data: null, sourceEventSeqs: [0, 1, 2] }
    const physical = releasedV3SessionFormatCodec.encodeHeader(current, 0)
    expect(physical).toEqual({ ...releasedV2SessionFormatCodec.encodeHeader(header, 0), version: 3 })
    expect(releasedV3SessionFormatCodec.decodeHeader(physical)).toEqual(current)
    const row = releasedV3SessionFormatCodec.encodeEvent(event)
    expect(row).toEqual(releasedV2SessionFormatCodec.encodeEvent(event))
    const decoder = releasedV3SessionFormatCodec.createDecoder(physical, 'strict')
    const context = new SessionFormatEventCollector()
    const first = { type: 'external/event', seq: 0, time: 1, data: null }
    decoder.decodeRow(first, context)
    expect(decoder.header).toEqual(current)
    expect(decoder.finish(context)).toBe(0)
    expect(context.values).toEqual([first])
  })

  it.each([null, [], false, { version: 2 }])('rejects a non-v3 physical header %j', (value) => {
    expect(() => releasedV3SessionFormatCodec.decodeHeader(value)).toThrow(/format v3 physical/)
  })

  it.each([false, true])('validates V2 delivery ownership before promotion (inherited=%s)', (inherited) => {
    const source = { ...header, isSeeded: inherited, ...(inherited ? { parentSession: 'parent' } : {}) }
    const stage = sessionFormatV2ToV3.createStage({
      sourceHeader: source, targetHeader: { ...source, version: 3 },
      sourceInheritedEventCount: undefined, sourceKind: 'decoded',
    })
    const context = new SessionFormatEventCollector()
    stage.transformEvent({ type: 'session-log-deepseek/delivery-accepted', seq: 0, time: 1,
      data: { sessionId: 'parent', sessionFormatVersion: 2 } }, context)
    if (inherited) stage.transformEvent({ type: 'session/end-seed', seq: 1, time: 1, data: { inherited: true } }, context)
    if (inherited) {
      expect(stage.finish(context)).toBe(1)
      stage.transformEvent({ type: 'session-log-deepseek/delivery-accepted', seq: 2, time: 1,
        data: { sessionId: 'parent', sessionFormatVersion: 2 } }, context)
    }
    expect(() => stage.finish(context)).toThrow(/wrong Session/)
  })

  it('checks native v3 delivery ownership without reinterpreting historical markers', () => {
    const artifact = (version: number) => ({
      header: { ...header, version: 3 }, inheritedEventCount: 0, events: [{
        type: 'session-log-deepseek/delivery-accepted', seq: 0, time: 1,
        data: { sessionId: 'other-session', throughSeq: 0, sessionFormatVersion: version },
      }],
    })
    expect(() => restoreReleasedV3Artifact(artifact(3), new Set())).toThrow(/wrong Session/)
    expect(restoreReleasedV3Artifact(artifact(2), new Set()).events).toEqual(artifact(2).events)
  })

  it('validates v3 metadata and event admission without mutating the artifact', () => {
    expect(() => { assertReleasedV3Header(header) }).toThrow(/format v3 header/)
    expect(() => { assertReleasedV3Header({ ...header, version: 3, cwd: 'relative' }) }).toThrow(/absolute/)
    const artifact = { header: { ...header, version: 3 }, inheritedEventCount: 0, events: [
      { type: 'external/event', seq: 0, time: 1, data: null, ignorable: true },
    ] }
    expect(restoreReleasedV3Artifact(artifact, new Set())).toBe(artifact)
    expect(artifact.header.version).toBe(3)
    expect(() => restoreReleasedV3Artifact({ ...artifact, events: [
      { type: 'external/required', seq: 0, time: 1, data: null },
    ] }, new Set())).toThrow(/unknown event type/)
  })
})
