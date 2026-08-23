import { describe, expect, it, vi } from 'vitest'
import {
  RemoteStream,
  RemoteStreamCarrierError,
  type RemoteStreamOptions,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  apply,
  createWorkspaceStateStream,
  type WorkspaceFollowSink,
  type WorkspaceRemote,
} from '../src/client/index.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspaceRenameRequest,
  WorkspaceValue,
} from '../src/types.ts'

interface Generation {
  readonly frames: readonly WorkspaceFollowFrame[]
  readonly error?: unknown
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

function workspaceClient(
  remote: WorkspaceRemote,
  connection: Pick<ConnectionHandle, 'hostDescription'> = AVAILABLE_CONNECTION,
) {
  return {
    workspace: remote,
    $stream: <Item>(options: RemoteStreamOptions<Item>) => new RemoteStream(connection, options),
  }
}

const baseline = (id?: string): Extract<WorkspaceFollowFrame, { type: 'baseline' }> => ({
  type: 'baseline',
  value: {
    items: id === undefined ? [] : [{
      workspaceId: id as never,
      path: `/work/${id}`,
      title: id,
      sessionIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    archivedSessionIds: [],
  },
})

function accepts(overrides: Partial<WorkspaceFollowSink> = {}): WorkspaceFollowSink {
  const ignore = (): void => {}
  return {
    replaceBaseline: ignore,
    upsertView: ignore,
    removeView: ignore,
    replaceOrder: ignore,
    replaceArchived: ignore,
    ...overrides,
  }
}

class ScriptedWorkspaceRemote implements WorkspaceRemote {
  readonly signals: AbortSignal[] = []
  calls = 0

  constructor(private readonly generations: readonly Generation[]) {}

  create(_request: WorkspaceCreateRequest): Promise<RemoteResult<WorkspaceCreateValue>> {
    throw new Error('unused')
  }

  rename(_request: WorkspaceRenameRequest): Promise<RemoteResult<WorkspaceValue>> {
    throw new Error('unused')
  }

  delete(_request: WorkspaceDeleteRequest): Promise<RemoteResult<WorkspaceDeleteValue>> {
    throw new Error('unused')
  }

  insertBefore(_request: WorkspaceInsertBeforeRequest): Promise<RemoteResult<WorkspaceOrderValue>> {
    throw new Error('unused')
  }

  insertSessionBefore(_request: WorkspaceInsertSessionBeforeRequest): Promise<RemoteResult<WorkspaceValue>> {
    throw new Error('unused')
  }

  archiveSession(_request: WorkspaceArchiveSessionRequest): Promise<RemoteResult<WorkspaceArchiveValue>> {
    throw new Error('unused')
  }

  async *follow(signal = new AbortController().signal): AsyncIterable<WorkspaceFollowFrame> {
    const generation = this.generations[this.calls++]
    if (generation === undefined) throw new Error('no scripted Workspace generation')
    this.signals.push(signal)
    for (const frame of generation.frames) yield frame
    if (generation.error !== undefined) throw generation.error
    if (generation.hold === true && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }
}

describe('Workspace Client snapshot adapter', () => {
  it('installs no Client service and maps the baseline plus every increment', async () => {
    apply()
    const opening = baseline('one')
    const workspace = opening.value.items[0]!
    const remote = new ScriptedWorkspaceRemote([{
      frames: [
        opening,
        { type: 'upsert', workspace },
        { type: 'remove', workspaceId: workspace.workspaceId },
        { type: 'order', workspaceIds: [workspace.workspaceId] },
        { type: 'archived', archivedSessionIds: ['session-one' as never] },
      ],
      hold: true,
    }])
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const upsertView = vi.fn<WorkspaceFollowSink['upsertView']>()
    const removeView = vi.fn<WorkspaceFollowSink['removeView']>()
    const replaceOrder = vi.fn<WorkspaceFollowSink['replaceOrder']>()
    const replaceArchived = vi.fn<WorkspaceFollowSink['replaceArchived']>()
    const accept = accepts({
      replaceBaseline,
      upsertView,
      removeView,
      replaceOrder,
      replaceArchived,
    })
    const stream = createWorkspaceStateStream(workspaceClient(remote), {
      accept,
      failed: vi.fn(),
    })

    stream.start()
    stream.start()
    await vi.waitFor(() => { expect(replaceArchived).toHaveBeenCalledOnce() })

    expect(replaceBaseline).toHaveBeenCalledWith(opening.value)
    expect(upsertView).toHaveBeenCalledWith(workspace)
    expect(removeView).toHaveBeenCalledWith(workspace.workspaceId)
    expect(replaceOrder).toHaveBeenCalledWith([workspace.workspaceId])
    expect(replaceArchived).toHaveBeenCalledWith(['session-one'])
    await stream.dispose()
    expect(remote.signals[0]?.aborted).toBe(true)
  })

  it('retains the old state across carrier loss and applies the replacement baseline', async () => {
    const carrier = new RemoteStreamCarrierError('socket lost')
    const remote = new ScriptedWorkspaceRemote([
      { frames: [baseline('old')], error: carrier },
      { frames: [baseline('fresh')], hold: true },
    ])
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const carrierFailed = vi.fn()
    const failed = vi.fn()
    const stream = createWorkspaceStateStream(workspaceClient(remote), {
      accept: accepts({ replaceBaseline }),
      carrierFailed,
      failed,
    })

    stream.start()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledTimes(2) })

    expect(replaceBaseline.mock.calls.map(([value]) => value.items[0]?.title)).toEqual(['old', 'fresh'])
    expect(carrierFailed).toHaveBeenCalledWith(carrier)
    expect(failed).not.toHaveBeenCalled()
    await stream.dispose()
  })

  it('classifies a normal end after the opening baseline as carrier loss', async () => {
    const remote = new ScriptedWorkspaceRemote([
      { frames: [baseline('old')] },
      { frames: [baseline('fresh')], hold: true },
    ])
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const carrierFailed = vi.fn()
    const stream = createWorkspaceStateStream(workspaceClient(remote), {
      accept: accepts({ replaceBaseline }),
      carrierFailed,
      failed: vi.fn(),
    })

    stream.start()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledTimes(2) })
    expect(carrierFailed.mock.calls[0]?.[0]).toMatchObject({
      message: 'Workspace state stream ended without a terminal result',
    })
    await stream.dispose()
  })

  it('suppresses callback failure after disposal begins', async () => {
    const failed = vi.fn()
    let closing: Promise<void> | undefined
    const stream = createWorkspaceStateStream(
      workspaceClient(new ScriptedWorkspaceRemote([{ frames: [baseline()] }])),
      {
        accept: accepts({
          replaceBaseline: () => {
            closing = stream.dispose()
            throw new Error('disposed callback')
          },
        }),
        failed,
      },
    )

    stream.start()
    await vi.waitFor(() => { expect(closing).toBeDefined() })
    await closing
    expect(failed).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'an increment before the baseline',
      frames: [{ type: 'remove', workspaceId: 'one' as never }] as WorkspaceFollowFrame[],
      message: 'update before its opening snapshot',
    },
    {
      name: 'a duplicate baseline',
      frames: [baseline(), baseline()] as WorkspaceFollowFrame[],
      message: 'more than one opening snapshot',
    },
    {
      name: 'a normal end before the baseline',
      frames: [] as WorkspaceFollowFrame[],
      message: 'ended before its opening snapshot',
    },
  ])('reports $name as a terminal failure', async ({ frames, message }) => {
    const failed = vi.fn()
    const stream = createWorkspaceStateStream(
      workspaceClient(new ScriptedWorkspaceRemote([{ frames }])),
      { accept: accepts(), failed },
    )

    stream.start()
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    const failure: unknown = failed.mock.calls[0]?.[0]
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('expected Workspace stream failure')
    expect(failure.message).toContain(message)
    await stream.dispose()
  })

  it('restarts a live generation without reporting cancellation as failure', async () => {
    const remote = new ScriptedWorkspaceRemote([
      { frames: [baseline('first')], hold: true },
      { frames: [baseline('second')], hold: true },
    ])
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const failed = vi.fn()
    const stream = createWorkspaceStateStream(workspaceClient(remote), {
      accept: accepts({ replaceBaseline }),
      failed,
    })

    stream.start()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledOnce() })
    stream.restart()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledTimes(2) })
    expect(failed).not.toHaveBeenCalled()
    await stream.dispose()
  })
})
