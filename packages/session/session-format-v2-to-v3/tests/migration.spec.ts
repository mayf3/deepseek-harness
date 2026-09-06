import { describe, expect, it, vi } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatHeader, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedV3Header,
  releasedV2SessionFormatCodec,
  releasedV3SessionFormatCodec,
  restoreReleasedV3Artifact,
  sessionFormatV2ToV3,
} from '../src/index.ts'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const header: SessionFormatHeader = deepFreeze({
  version: 2, id: 'tools-code-mode:session', createdAt: 1, isSeeded: false, delegationDepth: 0,
})

function migrateEvents(events: SessionFormatEvent[]): SessionFormatEvent[] {
  deepFreeze(events)
  const stage = sessionFormatV2ToV3.createStage({
    sourceHeader: header, targetHeader: sessionFormatV2ToV3.migrateHeader(header),
    sourceInheritedEventCount: 0, sourceKind: 'decoded',
  })
  const collector = new SessionFormatEventCollector()
  for (const event of events) stage.transformEvent(event, collector)
  expect(stage.finish(collector)).toBe(0)
  return collector.values
}

describe('v2 to v3 PTC migration', () => {
  it('changes the header version and forwards unrelated events and runs without expansion', () => {
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


  it.each([
    ['tool/code-dispatch-start', 'tool/ptc-dispatch-start'],
    ['tool/code-dispatch', 'tool/ptc-dispatch'],
  ])('renames only the exact %s envelope tag', (type, targetType) => {
    const event = deepFreeze({
      type, seq: 41, time: -17, ignorable: true,
      data: {
        rootCallId: 'tools-code-mode:root', parentCallId: 'tools-ptc:root', subCallId: 'tool/code-dispatch',
        name: 'tool/code-dispatch-start', arguments: { plugin: 'tools-code-mode' },
        content: [{ type: 'text', text: 'tool/code-dispatch tools-code-mode' }],
        source: { kind: 'plugin', plugin: 'tools-code-mode' }, extra: { nested: ['tools-code-mode'] },
      },
      sourceEventSeqs: [3, 7], surfaceOp: { op: 'replace', start: 3, end: 7 },
      extension: { type: 'tool/code-dispatch' },
    })
    const before = JSON.stringify(event)
    const [output] = migrateEvents([event])
    expect(output).toEqual({ ...event, type: targetType })
    expect(output).not.toBe(event)
    expect(output?.data).toBe(event.data)
    expect(output?.['sourceEventSeqs']).toBe(event.sourceEventSeqs)
    expect(output?.['surfaceOp']).toBe(event.surfaceOp)
    expect(output?.['extension']).toBe(event.extension)
    expect(JSON.stringify(event)).toBe(before)
  })

  it.each(['user/message', 'agent/inbox/spliced', 'session/title-llm-request'])('rewrites only owned plugin attribution in %s', (type) => {
    const message = deepFreeze({
      id: 'tools-code-mode:message', role: 'user',
      source: { kind: 'plugin', plugin: 'tools-code-mode', id: 'tools-code-mode:source', extra: ['tools-code-mode'] },
      content: [
        { type: 'text', text: '{"type":"tool/code-dispatch","source":{"kind":"plugin","plugin":"tools-code-mode"}}' },
        { type: 'tool-result', toolCallId: 'tools-code-mode:call', content: [{ type: 'text', text: 'tools-code-mode' }] },
        { type: 'extension', source: { kind: 'plugin', plugin: 'tools-code-mode' } },
      ],
      extra: { source: { kind: 'plugin', plugin: 'tools-code-mode' } },
    })
    const untouched = { ...message, id: 'tools-ptc:message', source: { kind: 'user', plugin: 'tools-code-mode' } }
    const key = type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
    const data = type === 'user/message' ? message : {
      [key]: [untouched, message], removed: [message.id], messageSeqs: [1, 4],
      source: message.source, extra: { messages: [message] },
    }
    const event = deepFreeze({ type, seq: 9, time: 111, data, sourceEventSeqs: [1, 4], surfaceOp: { op: 'replace', start: 1, end: 4 } })
    const renamed = { ...message, source: { ...message.source, plugin: 'tools-ptc' } }
    const before = JSON.stringify(event)
    const [output] = migrateEvents([event])
    expect(output).toEqual({ ...event, data: type === 'user/message' ? renamed : { ...data, [key]: [untouched, renamed] } })
    expect(output?.['sourceEventSeqs']).toBe(event.sourceEventSeqs)
    expect(output?.['surfaceOp']).toBe(event.surfaceOp)
    expect(JSON.stringify(event)).toBe(before)
  })

  it('retains no-op messages, malformed extension values, and non-plugin lookalikes by reference', () => {
    const messages: SessionFormatJsonValue[] = [
      null, false, 7, 'tools-code-mode', [], {}, { source: null }, { source: [] }, { source: 'tools-code-mode' },
      { source: { plugin: 'tools-code-mode' } }, { source: { kind: 'user', plugin: 'tools-code-mode' } },
      ...['tools-ptc', 'tools-code-mode-extra', '@deepseek-ai/dsh-tools-code-mode', 'Tools-code-mode'].map(plugin => ({ source: { kind: 'plugin', plugin } })),
    ]
    const events: SessionFormatEvent[] = messages.map((data, seq) => ({ type: 'user/message', seq, time: 1, data }))
    for (const type of ['agent/inbox/spliced', 'session/title-llm-request']) {
      const key = type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
      for (const data of [null, false, [], {}, { [key]: null }, { [key]: {} }, { [key]: [] }, { [key]: messages }]) {
        events.push({ type, seq: events.length, time: 1, data })
      }
    }
    const outputs = migrateEvents(events)
    expect(outputs).toEqual(events)
    for (const [index, event] of events.entries()) expect(outputs[index]).toBe(event)
  })

  it('leaves spoofed names and message-shaped values in unrelated payloads opaque', () => {
    const data = {
      type: 'tool/code-dispatch', source: { kind: 'plugin', plugin: 'tools-code-mode' },
      inserted: [{ source: { kind: 'plugin', plugin: 'tools-code-mode' } }],
      messages: [{ source: { kind: 'plugin', plugin: 'tools-code-mode' } }],
      text: 'tool/code-dispatch-start tools-code-mode',
    }
    const events = [
      'tool/code-dispatch-extra', 'tool/code-dispatch-started', 'tool/ptc-dispatch-extra', 'tool/ptc-dispatch-started',
      'external/event', 'assistant/message', 'tool/result', 'agent/inbox/spliced-extra', 'session/title',
    ].map((type, seq) => ({ type, seq, time: 1, data, ignorable: true }))
    const outputs = migrateEvents(events)
    for (const [index, event] of events.entries()) expect(outputs[index]).toBe(event)
  })

  it.each(['decoded', 'transformed'] as const)('refuses required and ignorable V3 tag collisions from %s V2 events', (sourceKind) => {
    for (const type of ['tool/ptc-dispatch-start', 'tool/ptc-dispatch']) {
      for (const ignorable of [false, true]) {
        const stage = sessionFormatV2ToV3.createStage({
          sourceHeader: header, targetHeader: sessionFormatV2ToV3.migrateHeader(header),
          sourceInheritedEventCount: 0, sourceKind,
        })
        const event = deepFreeze({ type, seq: 0, time: 1, data: null, ...(ignorable ? { ignorable: true } : {}) })
        const collector = new SessionFormatEventCollector()
        expect(() => { stage.transformEvent(event, collector) }).toThrow(/format v2.*ptc-dispatch/)
        expect(collector.values).toEqual([])
      }
    }
  })

  it('does not collapse old-prefix and new-prefix message IDs or rewrite references', () => {
    const messages = ['tools-code-mode:result', 'tools-ptc:result'].map(id => ({
      id, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'plugin', plugin: 'tools-code-mode' },
    }))
    const events = [
      ...messages.map((data, seq) => ({ type: 'user/message', seq, time: seq + 1, data })),
      { type: 'agent/inbox/spliced', seq: 2, time: 3, data: { inserted: messages, removed: messages.map(message => message.id) } },
      { type: 'external/references', seq: 3, time: 4, data: { messageId: 'tools-code-mode:result', callId: 'tools-code-mode:call' } },
    ]
    const before = JSON.stringify(events)
    expect(migrateEvents(events)).toEqual([
      ...messages.map((data, seq) => ({ type: 'user/message', seq, time: seq + 1, data: { ...data, source: { ...data.source, plugin: 'tools-ptc' } } })),
      { ...events[2], data: { inserted: messages.map(data => ({ ...data, source: { ...data.source, plugin: 'tools-ptc' } })), removed: messages.map(message => message.id) } },
      events[3],
    ])
    expect(JSON.stringify(events)).toBe(before)
  })

  it('keeps own and historical delivery markers unchanged', () => {
    const events = [null, {}, { sessionFormatVersion: 1, sessionId: 'other' }, { sessionFormatVersion: 2, sessionId: header.id }]
      .map((data, seq) => ({ type: 'session-log-deepseek/delivery-accepted', seq, time: 1, data }))
    expect(migrateEvents(events)).toEqual(events)
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

  it.each(['tool/code-dispatch-start', 'tool/code-dispatch'])('keeps %s in the frozen v2 codec but rejects it as required native v3 input', (type) => {
    const row = deepFreeze({ type, seq: 0, time: 1, data: { text: 'tools-code-mode' } })
    const v2 = releasedV2SessionFormatCodec.createDecoder(releasedV2SessionFormatCodec.encodeHeader(header, 0), 'strict')
    const oldEvents = new SessionFormatEventCollector()
    v2.decodeRow(row, oldEvents)
    expect(v2.finish(oldEvents)).toBe(0)
    expect(oldEvents.values).toEqual([row])

    const physical = releasedV3SessionFormatCodec.encodeHeader({ ...header, version: 3 }, 0)
    const required = releasedV3SessionFormatCodec.createDecoder(physical, 'strict')
    const rejected = new SessionFormatEventCollector()
    expect(() => { required.decodeRow(row, rejected) }).toThrow(/format v3 contains unknown event type/)
    expect(rejected.values).toEqual([])

    const opaqueRow = deepFreeze({ ...row, ignorable: true })
    const ignorable = releasedV3SessionFormatCodec.createDecoder(physical, 'strict')
    const accepted = new SessionFormatEventCollector()
    ignorable.decodeRow(opaqueRow, accepted)
    expect(ignorable.finish(accepted)).toBe(0)
    expect(accepted.values).toEqual([opaqueRow])
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

  it.each([undefined, 0, 1, 2, 4])('preserves delivery marker generation %s verbatim', (version) => {
    const stage = sessionFormatV2ToV3.createStage({
      sourceHeader: header, targetHeader: { ...header, version: 3 },
      sourceInheritedEventCount: 0, sourceKind: 'decoded',
    })
    const event = { type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2,
      data: { sessionId: header.id, throughSeq: 0, ...(version === undefined ? {} : { sessionFormatVersion: version }) } }
    const context = new SessionFormatEventCollector()
    stage.transformEvent(event, context)
    expect(stage.finish(context)).toBe(0)
    expect(context.values).toEqual([event])
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


describe('v3 PTC event admission and relationships', () => {
  const turn = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
  const dispatch = {
    rootCallId: 'tools-code-mode:root', parentCallId: 'tools-code-mode:root', subCallId: 'tools-code-mode:child',
    name: 'read', arguments: { path: 'tools-code-mode', nested: [1, { text: 'tool/code-dispatch' }] },
  }
  const start = { type: 'tool/ptc-dispatch-start', seq: 1, time: 2, data: dispatch }
  const settle = {
    type: 'tool/ptc-dispatch', seq: 2, time: 3,
    data: { ...dispatch, isError: false, content: [{ type: 'text', text: 'tools-code-mode' }] },
  }
  const artifact = (events: SessionFormatEvent[]) => deepFreeze({
    header: { ...header, version: 3 }, inheritedEventCount: 0, events,
  })

  it('validates a frozen complete PTC lifecycle and returns original names, IDs, and references', () => {
    const source = artifact([turn, start, settle, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } }])
    const before = JSON.stringify(source)
    const restored = restoreReleasedV3Artifact(source, new Set(['tool/ptc-dispatch-start', 'tool/ptc-dispatch']))
    expect(restored).toBe(source)
    expect(restored.events).toBe(source.events)
    for (const [index, event] of source.events.entries()) expect(restored.events[index]).toBe(event)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('accepts an unfinished PTC start without requiring a fabricated settlement', () => {
    const source = artifact([turn, start])
    expect(restoreReleasedV3Artifact(source, new Set())).toBe(source)
  })

  it('rejects an orphan PTC settlement', () => {
    expect(() => restoreReleasedV3Artifact(artifact([turn, { ...settle, seq: 1 }]), new Set())).toThrow(/no unique start/)
  })

  it.each([
    { name: 'other' }, { arguments: { path: 'different' } }, { subCallId: 'other-child' },
    { parentCallId: 'missing-parent' }, { rootCallId: 'different-root' },
  ])('rejects a PTC settlement whose identity or input disagrees with its start: %j', (override) => {
    expect(() => restoreReleasedV3Artifact(artifact([turn, start, { ...settle, data: { ...settle.data, ...override } }]), new Set()))
      .toThrow(/does not match|no unique start|parentCallId|rootCallId/)
  })

  it.each([start, settle])('rejects $type outside an open turn', (event) => {
    expect(() => restoreReleasedV3Artifact(artifact([{ ...event, seq: 0 }]), new Set())).toThrow(/outside an open turn/)
  })

  it('rejects duplicate PTC starts and settlements', () => {
    expect(() => restoreReleasedV3Artifact(artifact([turn, start, { ...start, seq: 2 }]), new Set())).toThrow(/repeats subCallId/)
    expect(() => restoreReleasedV3Artifact(artifact([turn, start, settle, { ...settle, seq: 3 }]), new Set())).toThrow(/no unique start/)
  })

  it.each(['tool/code-dispatch-start', 'tool/code-dispatch'])('rejects required obsolete %s even when installed', (type) => {
    expect(() => restoreReleasedV3Artifact(artifact([{ type, seq: 0, time: 1, data: null }]), new Set([type])))
      .toThrow(/format v3 contains unknown event type/)
  })

  it.each(['tool/code-dispatch-start', 'tool/code-dispatch', 'external/future'])('preserves ignorable %s as opaque data outside a turn', (type) => {
    const source = artifact([{
      type, seq: 0, time: -5, ignorable: true,
      data: { source: { kind: 'plugin', plugin: 'tools-code-mode' }, invalidLifecycle: true, content: ['tool/code-dispatch'] },
      sourceEventSeqs: [17], surfaceOp: { unknown: ['tools-code-mode'] },
    }])
    expect(restoreReleasedV3Artifact(source, new Set())).toBe(source)
    expect(source.events[0]?.type).toBe(type)
  })

  it('does not let an ignorable obsolete start satisfy a current PTC settlement', () => {
    const obsolete = { ...start, type: 'tool/code-dispatch-start', ignorable: true }
    expect(() => restoreReleasedV3Artifact(artifact([turn, obsolete, settle]), new Set())).toThrow(/no unique start/)
  })
})
