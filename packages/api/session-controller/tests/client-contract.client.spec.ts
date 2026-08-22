import type { SessionEventEntry } from '@deepseek-ai/dsh-api-session-controller/types'
import { describe, expect, it, vi } from 'vitest'
import { MutableSessionEventSource } from '../src/client/contract/events.ts'
import { transportResult } from '../src/client/contract/result.ts'

function entry(seq: number): SessionEventEntry {
  return {
    event: {
      type: 'fixture/event',
      seq,
      time: seq,
      data: { seq },
      ignorable: true,
    },
  }
}

describe('Client Session contracts', () => {
  it('publishes exact replace, prepend, and append event-window changes', () => {
    const feed = new MutableSessionEventSource()
    const listener = vi.fn()
    const dispose = feed.subscribe(listener)
    const first = entry(1)
    const older = entry(0)
    const live = entry(2)

    feed.replace([first], true)
    expect(feed.getSnapshot()).toEqual({
      entries: [first],
      hasMore: true,
      revision: 1,
      change: { kind: 'replace', entries: [first] },
    })

    feed.prepend([older], false)
    expect(feed.getSnapshot()).toEqual({
      entries: [older, first],
      hasMore: false,
      revision: 2,
      change: { kind: 'prepend', entries: [older] },
    })

    feed.append(live)
    expect(feed.getSnapshot()).toEqual({
      entries: [older, first, live],
      hasMore: false,
      revision: 3,
      change: { kind: 'append', entries: [live] },
    })
    expect(listener).toHaveBeenCalledTimes(3)

    dispose()
    feed.append(entry(3))
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('folds Error and non-Error carrier rejections into Client failures', () => {
    expect(transportResult(new Error('transport unavailable'))).toEqual({
      ok: false,
      error: { code: 'internal', message: 'transport unavailable', details: {} },
    })
    expect(transportResult(404)).toEqual({
      ok: false,
      error: { code: 'internal', message: '404', details: {} },
    })
  })
})
