import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { apply, createActivityRosterStream } from '../src/client/index.ts'
import { ClientActivityModel } from '../src/client/model.ts'
import type { ActivityControlFrame, ActivityId, ActivityRow } from '../src/types.ts'

function row(): ActivityRow {
  return {
    id: 'bash-1' as ActivityId,
    kind: 'bash',
    label: 'build',
    status: 'running',
    startedAt: 1,
    outputTotal: 0,
  }
}

/** One scripted roster stream: frames pushed by the test, never reopened. */
class FakeStream {
  disposed = false
  private readonly frames: ActivityControlFrame[] = []
  private waiter: (() => void) | undefined
  private failure: Error | undefined

  push(frame: ActivityControlFrame): void {
    this.frames.push(frame)
    this.waiter?.()
  }

  poison(error: Error): void {
    this.failure = error
    this.waiter?.()
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.waiter?.()
    return Promise.resolve()
  }

  async *[Symbol.asyncIterator]() {
    while (!this.disposed) {
      if (this.failure !== undefined) throw this.failure
      const frame = this.frames.shift()
      if (frame === undefined) {
        await new Promise<void>((resolve) => { this.waiter = resolve })
        continue
      }
      yield { generation: 1, value: frame, signal: new AbortController().signal, accept: () => {} }
    }
  }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('activity-controller client plugin', () => {
  it('installs ctx.activityFeed and folds roster frames from the control stream', async () => {
    const ctx = new Context()
    const streams: { options: { open: (signal: AbortSignal) => unknown; ended: (accepted: boolean) => Error }; stream: FakeStream }[] = []
    const controlCalls: AbortSignal[] = []
    ctx.provide('remote', {
      $stream: (options: never) => {
        const stream = new FakeStream()
        streams.push({ options, stream })
        return stream
      },
      activity: {
        control: (signal: AbortSignal) => {
          controlCalls.push(signal)
          return { [Symbol.asyncIterator]: async function* () { /* never yields */ } }
        },
        observe: () => { throw new Error('not exercised') },
      },
    } as never)
    const fiber = ctx.plugin({ inject: ['remote'], apply })
    await fiber

    streams[0]!.stream.push({ type: 'baseline', activities: [row()] })
    streams[0]!.stream.push({ type: 'rows', activities: [] })
    await tick()
    const snapshot = ctx.activityFeed.state.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.rowsBySession['']).toBeUndefined()

    // The generation opener and end classification belong to the domain.
    streams[0]!.options.open(new AbortController().signal)
    expect(controlCalls).toHaveLength(1)
    expect(streams[0]!.options.ended(true)).toBeInstanceOf(RemoteStreamCarrierError)
    expect(streams[0]!.options.ended(false)).toBeInstanceOf(Error)

    // A terminal roster failure keeps the last snapshot in place.
    streams[0]!.stream.poison(new Error('roster stream broke'))
    await tick()
    expect(ctx.activityFeed.state.getSnapshot().phase).toBe('ready')

    await fiber.dispose()
    expect(streams[0]!.stream.disposed).toBe(true)
  })

  it('keeps the last roster on a terminal stream failure', async () => {
    const model = new ClientActivityModel()
    const remote = {
      $stream: () => new FakeStream(),
      activity: { control: () => { throw new Error('unused') }, observe: () => { throw new Error('unused') } },
    }
    const stream = createActivityRosterStream(remote as never, model)
    model.replaceBaseline([row()])
    stream.start()
    await stream.dispose()
    expect(model.getSnapshot().rowsBySession['']?.[0]?.label).toBe('build')
  })
})
