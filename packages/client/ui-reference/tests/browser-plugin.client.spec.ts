/**
 * Web reference source coverage: Host-backed file/session discovery,
 * deterministic ordering and labels, quoted-path suppression, pick projections, codec
 * round-trip, and registration lifecycle.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { FileReferenceItem, SessionReferenceItem } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CandidateRequest, ClientSessionContext, InputTriggerCandidate, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply, inject } from '../src/client/index.ts'

const sid = (value: string): SessionId => value as SessionId
const session: ClientSessionContext = { sessionId: sid('target') }

type ReferenceResponse<T> =
  | { result: { ok: true; value: { items: T[] } } }
  | { result: { ok: false; error: { code: string; message: string } } }

type ReferenceLookup<T> = (
  payload: unknown,
  signal?: AbortSignal,
) => Promise<ReferenceResponse<T>>

function request(
  query: string,
  options: { quoted?: boolean; signal?: AbortSignal } = {},
): CandidateRequest {
  return {
    query,
    quoted: options.quoted ?? false,
    position: 'inline',
    signal: options.signal ?? new AbortController().signal,
  }
}

async function bench(
  files: ReferenceLookup<FileReferenceItem> = vi.fn(() => Promise.resolve({
    result: {
      ok: true as const,
      value: {
        items: [
          { path: 'src', kind: 'directory' as const },
          { path: 'docs/a b.md', kind: 'file' as const },
        ],
      },
    },
  })),
  sessions: ReferenceLookup<SessionReferenceItem> = vi.fn(() => Promise.resolve({
    result: {
      ok: true as const,
      value: {
        items: [{
          sessionId: sid('source'),
          label: 'Research',
          cwd: '/project',
          createdAt: 1_700_000_000_000,
          mention: '@[Research](dsh-session:InNvdXJjZSI)',
        }],
      },
    },
  })),
): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']>; source: InputTriggerSource }> {
  const ctx = new Context()
  let source: InputTriggerSource | undefined
  ctx.provide('inputTriggers', {
    registerSource(candidate: InputTriggerSource) {
      source = candidate
      return () => { source = undefined }
    },
  })
  ctx.provide('connection', { api: { references: { files, sessions } } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  if (source === undefined) throw new Error('reference source was not registered')
  return { ctx, fiber, source }
}

describe('apply', () => {
  it('declares its services and releases the @ reference registration on disposal', async () => {
    expect(inject).toEqual(['inputTriggers', 'connection'])
    const ctx = new Context()
    let registered: InputTriggerSource | undefined
    ctx.provide('inputTriggers', {
      registerSource(source: InputTriggerSource) {
        registered = source
        return () => { registered = undefined }
      },
    })
    ctx.provide('connection', {
      api: {
        references: {
          files: () => Promise.resolve({ result: { ok: true, value: { items: [] } } }),
          sessions: () => Promise.resolve({ result: { ok: true, value: { items: [] } } }),
        },
      },
    } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(registered).toMatchObject({ trigger: '@', name: 'reference' })
    await fiber.dispose()
    expect(registered).toBeUndefined()
  })
})

describe('candidates', () => {
  it('starts both Host lookups together and renders files before sessions with stable labels', async () => {
    let releaseFiles!: () => void
    let releaseSessions!: () => void
    const files = vi.fn(() => new Promise<{
      result: { ok: true; value: { items: { path: string; kind: 'file' | 'directory' }[] } }
    }>((resolve) => {
      releaseFiles = () => {
        resolve({
          result: {
            ok: true,
            value: {
              items: [
                { path: 'src', kind: 'directory' },
                { path: 'docs/a b.md', kind: 'file' },
              ],
            },
          },
        })
      }
    }))
    const sessions = vi.fn(() => new Promise<{
      result: {
        ok: true
        value: {
          items: {
            sessionId: SessionId
            label: string
            cwd: string
            createdAt: number
            mention: string
          }[]
        }
      }
    }>((resolve) => {
      releaseSessions = () => {
        resolve({
          result: {
            ok: true,
            value: {
              items: [{
                sessionId: sid('source'),
                label: 'Research',
                cwd: '/project',
                createdAt: 1_700_000_000_000,
                mention: '@[Research](dsh-session:InNvdXJjZSI)',
              }],
            },
          },
        })
      }
    }))
    const { source } = await bench(files, sessions)
    const pending = source.candidates(session, request('re'))
    expect(files).toHaveBeenCalledTimes(1)
    expect(sessions).toHaveBeenCalledTimes(1)
    releaseSessions()
    releaseFiles()
    await expect(pending).resolves.toEqual([
      expect.objectContaining({
        name: 'Folder · src/',
        description: 'src',
        section: '文件与文件夹',
      }),
      expect.objectContaining({
        name: 'File · a b.md',
        description: 'docs/a b.md',
        section: '文件与文件夹',
      }),
      expect.objectContaining({
        name: 'Session · Research',
        description: 'source · /project · 2023-11-14T22:13:20.000Z',
        section: 'Session 对话',
      }),
    ])
  })

  it('suppresses sessions for an open quoted path and degrades each failed domain independently', async () => {
    const files = vi.fn()
      .mockResolvedValueOnce({
        result: {
          ok: true as const,
          value: { items: [{ path: 'README.md', kind: 'file' as const }] },
        },
      })
      .mockRejectedValueOnce(new Error('file scan failed'))
    const sessions = vi.fn(() => Promise.resolve({
      result: {
        ok: true as const,
        value: {
          items: [{
            sessionId: sid('source'),
            label: 'Research',
            cwd: '/project',
            createdAt: 0,
            mention: '@[Research](dsh-session:InNvdXJjZSI)',
          }],
        },
      },
    }))
    const { source } = await bench(files, sessions)
    const quoted = await source.candidates(session, request('READ', { quoted: true }))
    expect(quoted).toEqual([expect.objectContaining({ name: 'File · README.md' })])
    expect(source.onPick({
      candidate: quoted[0]!,
      session,
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 6, draftRev: 1 },
    })).toEqual({ text: '@"README.md" ' })
    expect(sessions).not.toHaveBeenCalled()
    await expect(source.candidates(session, request('research'))).resolves.toEqual([
      expect.objectContaining({ name: 'Session · Research' }),
    ])
  })

  it('drops a completed result when the query signal was superseded', async () => {
    const controller = new AbortController()
    const { source } = await bench()
    const pending = source.candidates(session, request('', { signal: controller.signal }))
    controller.abort()
    await expect(pending).resolves.toEqual([])
  })

  it('treats Host errors as empty domains and filters paths that cannot be mentioned', async () => {
    const files = vi.fn(() => Promise.resolve({
      result: {
        ok: true as const,
        value: { items: [{ path: 'bad\nname', kind: 'file' as const }] },
      },
    }))
    const sessions = vi.fn()
      .mockRejectedValueOnce(new Error('session lookup failed'))
      .mockResolvedValueOnce({
        result: {
          ok: false as const,
          error: { code: 'reference-failed', message: 'session lookup failed' },
        },
      })
    const { source } = await bench(files, sessions)
    await expect(source.candidates(session, request('bad'))).resolves.toEqual([])

    files.mockResolvedValueOnce({
      result: {
        ok: false as const,
        error: { code: 'reference-failed', message: 'file lookup failed' },
      },
    } as never)
    await expect(source.candidates(session, request('bad'))).resolves.toEqual([])
  })

  it('omits redundant session ids and labels sessions without a cwd', async () => {
    const files = vi.fn(() => Promise.resolve({
      result: { ok: true as const, value: { items: [] } },
    }))
    const sessions = vi.fn(() => Promise.resolve({
      result: {
        ok: true as const,
        value: {
          items: [{
            sessionId: sid('same'),
            label: 'same',
            createdAt: 0,
            mention: '@[same](dsh-session:InNhbWUi)',
          }],
        },
      },
    }))
    const { source } = await bench(files, sessions)
    await expect(source.candidates(session, request('same'))).resolves.toEqual([
      expect.objectContaining({
        name: 'Session · same',
        description: '(no cwd) · 1970-01-01T00:00:00.000Z',
      }),
    ])
  })
})

describe('pick and codec', () => {
  const pick = (source: InputTriggerSource, candidate: InputTriggerCandidate) => source.onPick({
    candidate,
    session,
    position: 'inline',
    via: 'menu',
    span: { start: 0, end: 1, draftRev: 1 },
  })

  it('inserts files as path text, keeping directory completion open', async () => {
    const { source } = await bench()
    const [directory, file] = await source.candidates(session, request(''))
    expect(pick(source, directory!)).toEqual({ text: '@src/', continue: true })
    expect(pick(source, file!)).toEqual({ text: '@"docs/a b.md" ' })
    const [quotedDirectory] = await source.candidates(session, request('', { quoted: true }))
    expect(pick(source, quotedDirectory!)).toEqual({ text: '@"src/', continue: true })
  })

  it('inserts sessions as atomic chips whose clipboard and model forms are canonical mentions', async () => {
    const { source } = await bench()
    const candidates = await source.candidates(session, request(''))
    const candidate = candidates.find(item => item.name === 'Session · Research')!
    const mention = '@[Research](dsh-session:InNvdXJjZSI)'
    expect(pick(source, candidate)).toEqual({
      insert: {
        source: 'reference',
        ref: mention,
        label: '@Research',
        clipboardText: mention,
      },
    })
    expect(source.codec?.clipboardText(mention)).toBe(mention)
    await expect(source.codec?.serialize(mention, new AbortController().signal)).resolves.toBe(mention)
  })

  it('ignores candidates that do not carry a source-owned value', async () => {
    const { source } = await bench()
    expect(pick(source, { name: 'foreign candidate' })).toBeUndefined()
  })
})
