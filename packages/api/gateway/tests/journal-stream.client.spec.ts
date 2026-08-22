import { describe, expect, it, vi } from 'vitest'
import {
  RemoteJournalStream,
  RemoteStream,
  RemoteStreamCarrierError,
  type RemoteJournalChange,
  type RemoteJournalFrame,
  type RemoteStreamOptions,
} from '../src/client/index.ts'

interface Entry {
  readonly seq: number
}

interface Page {
  readonly entries: readonly Entry[]
  readonly hasMore: boolean
  readonly marker: string
}

interface PageRequest {
  readonly before?: number
  readonly limit?: number
}

interface Generation {
  readonly frames: readonly RemoteJournalFrame<Entry, number>[]
  readonly terminal?: Error
  readonly hold?: boolean
}

const AVAILABLE_CONNECTION = {
  hostDescription: {
    getSnapshot: () => ({
      version: 'fixture', cwd: '/fixture', attachedSessions: 0, home: '/home/fixture', canOpenPath: true,
    }),
    subscribe: () => () => {},
  },
}

const entries = (...seqs: number[]): Entry[] => seqs.map(seq => ({ seq }))

const page = (marker: string, seqs: number[], hasMore = false): Page => ({
  entries: entries(...seqs),
  hasMore,
  marker,
})

const STREAM_FACTORY = {
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
    return new RemoteStream(AVAILABLE_CONNECTION, options)
  },
}

class FixtureJournal extends RemoteJournalStream<Page, Entry, number, PageRequest> {
  constructor(
    private readonly generations: Generation[],
    private readonly pages: (Page | Promise<Page>)[],
    private readonly calls: string[],
    private readonly pageRequests: PageRequest[],
    private readonly followCursors: (number | undefined)[],
    changes: RemoteJournalChange<Page, Entry>[],
    failed: (error: unknown) => void,
  ) {
    super(STREAM_FACTORY, {
      name: 'fixture journal',
      emptyCursor: -1,
      entries: value => value.entries,
      hasMore: value => value.hasMore,
      cursor: entry => entry.seq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: (change) => { changes.push(change) },
      failed,
    })
  }

  /** @inheritdoc */
  protected override async * follow(
    after: number | undefined,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<Entry, number>> {
    this.calls.push('follow')
    this.followCursors.push(after)
    const generation = this.generations.shift()
    if (generation === undefined) throw new Error('no scripted journal generation')
    for (const frame of generation.frames) yield frame
    if (generation.terminal !== undefined) throw generation.terminal
    if (generation.hold === true && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }

  /** @inheritdoc */
  protected override readPage(request: PageRequest): Promise<Page> {
    this.calls.push('page')
    this.pageRequests.push(request)
    const value = this.pages.shift()
    if (value === undefined) throw new Error('no scripted journal page')
    return Promise.resolve(value)
  }

  /** @inheritdoc */
  protected override repairRequest(request: PageRequest): PageRequest {
    return request.limit === undefined ? {} : { limit: request.limit }
  }
}

function journalFixture(
  generations: Generation[],
  pages: (Page | Promise<Page>)[],
): {
  readonly journal: RemoteJournalStream<Page, Entry, number, PageRequest>
  readonly changes: RemoteJournalChange<Page, Entry>[]
  readonly failed: ReturnType<typeof vi.fn>
  readonly calls: string[]
  readonly pageRequests: PageRequest[]
  readonly followCursors: (number | undefined)[]
} {
  const calls: string[] = []
  const pageRequests: PageRequest[] = []
  const followCursors: (number | undefined)[] = []
  const changes: RemoteJournalChange<Page, Entry>[] = []
  const failed = vi.fn()
  const journal = new FixtureJournal(
    generations,
    pages,
    calls,
    pageRequests,
    followCursors,
    changes,
    failed,
  )
  return { journal, changes, failed, calls, pageRequests, followCursors }
}

describe('RemoteJournalStream', () => {
  it('opens follow before page, removes overlap, appends live entries, and prepends history', async () => {
    const fixture = journalFixture(
      [{
        frames: [
          { type: 'opened', cursor: 3 },
          { type: 'entry', entry: { seq: 3 } },
          { type: 'entry', entry: { seq: 4 } },
        ],
        hold: true,
      }],
      [page('tail', [2, 3], true), page('older', [0, 1])],
    )

    await fixture.journal.open({ limit: 2 })
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })
    await fixture.journal.prepend({ before: 2, limit: 2 })

    expect(fixture.calls.slice(0, 2)).toEqual(['follow', 'page'])
    expect(fixture.pageRequests).toEqual([{ limit: 2 }, { before: 2, limit: 2 }])
    expect(fixture.changes).toEqual([
      { type: 'replace', page: page('tail', [2, 3], true), entries: entries(2, 3), hasMore: true },
      { type: 'append', entry: { seq: 4 } },
      { type: 'prepend', page: page('older', [0, 1]), entries: entries(0, 1), hasMore: false },
    ])
    await fixture.journal.dispose()
    await fixture.journal.dispose()
  })

  it('publishes one sorted replacement from a repair page and live entries queued while it loads', async () => {
    let resolveRepair!: (value: Page) => void
    const repair = new Promise<Page>((resolve) => { resolveRepair = resolve })
    const fixture = journalFixture(
      [{
        frames: [
          { type: 'opened', cursor: 15 },
          { type: 'entry', entry: { seq: 17 } },
          { type: 'entry', entry: { seq: 16 } },
        ],
        hold: true,
      }],
      [page('stale', [6, 7, 8, 9, 10, 11]), repair],
    )

    const opening = fixture.journal.open({ limit: 6 })
    await vi.waitFor(() => {
      expect(fixture.calls.filter(call => call === 'page')).toHaveLength(2)
    })
    expect(fixture.changes).toEqual([])

    resolveRepair(page('repair', [10, 11, 12, 13, 14, 15]))
    await opening

    expect(fixture.changes).toEqual([{
      type: 'replace',
      page: page('repair', [10, 11, 12, 13, 14, 15]),
      entries: entries(10, 11, 12, 13, 14, 15, 16, 17),
      hasMore: false,
    }])
    await fixture.journal.dispose()
  })

  it('repairs a replacement generation through one tail page and drops replay overlap', async () => {
    const lost = new RemoteStreamCarrierError('carrier lost')
    const fixture = journalFixture(
      [
        {
          frames: [
            { type: 'opened', cursor: 1 },
            { type: 'entry', entry: { seq: 2 } },
          ],
          terminal: lost,
        },
        {
          frames: [
            { type: 'opened', cursor: 4 },
            { type: 'entry', entry: { seq: 3 } },
            { type: 'entry', entry: { seq: 4 } },
          ],
          hold: true,
        },
      ],
      [page('initial', [0, 1]), page('repair', [0, 1, 2, 3, 4])],
    )

    await fixture.journal.open({ limit: 5 })
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(3) })

    expect(fixture.changes.map(change => change.type)).toEqual(['replace', 'append', 'replace'])
    expect(fixture.changes[2]).toMatchObject({
      type: 'replace', page: { marker: 'repair' }, entries: entries(0, 1, 2, 3, 4),
    })
    expect(fixture.followCursors).toEqual([undefined, 2])
    expect(fixture.failed).not.toHaveBeenCalled()
    await fixture.journal.dispose()
  })

  it('repairs a live gap before publishing another change', async () => {
    const fixture = journalFixture(
      [{
        frames: [
          { type: 'opened', cursor: 1 },
          { type: 'entry', entry: { seq: 4 } },
        ],
        hold: true,
      }],
      [page('initial', [0, 1]), page('repair', [0, 1, 2, 3, 4])],
    )

    await fixture.journal.open({})
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })

    expect(fixture.changes.map(change => change.type)).toEqual(['replace', 'replace'])
    expect(fixture.changes[1]).toMatchObject({ page: { marker: 'repair' } })
    await fixture.journal.dispose()
  })

  it('rejects malformed opening and page sequences', async () => {
    const beforeOpening = journalFixture(
      [{ frames: [{ type: 'entry', entry: { seq: 0 } }] }],
      [page('unused', [])],
    )
    await expect(beforeOpening.journal.open({})).rejects.toThrow('entry before its opening cursor')

    const discontinuousPage = journalFixture(
      [{ frames: [{ type: 'opened', cursor: 3 }], hold: true }],
      [page('bad', [0, 2, 3])],
    )
    await expect(discontinuousPage.journal.open({})).rejects.toThrow('page contains discontinuous entries')

    const shortPage = journalFixture(
      [{ frames: [{ type: 'opened', cursor: 3 }], hold: true }],
      [page('short', [0, 1]), page('repair-short', [0, 1, 2])],
    )
    await expect(shortPage.journal.open({})).rejects.toThrow('page did not reach its opening cursor')
  })

  it('reports duplicate and regressed generation cursors as terminal failures', async () => {
    const duplicate = journalFixture(
      [{
        frames: [{ type: 'opened', cursor: 1 }, { type: 'opened', cursor: 1 }],
      }],
      [page('initial', [0, 1])],
    )
    await duplicate.journal.open({})
    await vi.waitFor(() => { expect(duplicate.failed).toHaveBeenCalledOnce() })
    const duplicateFailure: unknown = duplicate.failed.mock.calls[0]?.[0]
    expect(duplicateFailure).toBeInstanceOf(Error)
    if (!(duplicateFailure instanceof Error)) throw new Error('expected duplicate-cursor failure')
    expect(duplicateFailure.message).toContain('more than one opening cursor')

    const regressed = journalFixture(
      [
        {
          frames: [{ type: 'opened', cursor: 1 }, { type: 'entry', entry: { seq: 2 } }],
          terminal: new RemoteStreamCarrierError('lost'),
        },
        { frames: [{ type: 'opened', cursor: 1 }] },
      ],
      [page('initial', [0, 1])],
    )
    await regressed.journal.open({})
    await vi.waitFor(() => { expect(regressed.failed).toHaveBeenCalledOnce() })
    const regressedFailure: unknown = regressed.failed.mock.calls[0]?.[0]
    expect(regressedFailure).toBeInstanceOf(Error)
    if (!(regressedFailure instanceof Error)) throw new Error('expected regressed-cursor failure')
    expect(regressedFailure.message).toContain('behind the last applied entry')
  })

  it('rejects a discontinuous older page after publishing the fail-soft pagination state', async () => {
    const fixture = journalFixture(
      [{ frames: [{ type: 'opened', cursor: 4 }], hold: true }],
      [page('initial', [3, 4], true), page('older', [0, 1], true)],
    )
    await fixture.journal.open({})

    await expect(fixture.journal.prepend({ before: 3 })).rejects.toThrow('history page is discontinuous')
    expect(fixture.changes.at(-1)).toEqual({
      type: 'prepend', page: page('older', [0, 1], true), entries: [], hasMore: false,
    })
    await fixture.journal.dispose()
  })

  it('guards lifecycle operations before and after open', async () => {
    const fixture = journalFixture(
      [{ frames: [{ type: 'opened', cursor: -1 }], hold: true }],
      [page('empty', [])],
    )

    await expect(fixture.journal.prepend({})).rejects.toThrow('is not open')
    await fixture.journal.open({})
    await expect(fixture.journal.open({})).rejects.toThrow('already opened')
    fixture.journal.restart()
    await fixture.journal.dispose()
    await expect(fixture.journal.prepend({})).rejects.toThrow('is not open')
  })
})
