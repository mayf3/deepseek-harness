import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionMediaReferences } from '../src/media-references.ts'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
const TEXT_BYTES = new Uint8Array([1, 2, 3, 4])
const MP4_BYTES = new TextEncoder().encode('....ftypmp42....moov....')

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer())
}

/** One mounted plugin contribution with its registered `/api/file` handler. */
interface MountedRoute {
  /** GET/HEAD helper for one local path. */
  call(path: string, init?: RequestInit): Promise<Response>
  /** Direct request access (custom URLs and headers). */
  raw(url: string, init?: RequestInit): Promise<Response>
  unregister: ReturnType<typeof vi.fn>
  dispose(): Promise<void>
}

describe('SessionMediaReferences /api/file', () => {
  let root: string
  const contexts: Context[] = []

  beforeEach(async () => {
    // Real workspace roots are canonical; tmpdir may sit behind a symlink.
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-media-references-')))
  })

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await rm(root, { recursive: true, force: true })
  })

  async function mount(workspaceRoot: string = root): Promise<MountedRoute> {
    const ctx = new Context()
    contexts.push(ctx)
    let handler: ((request: Request) => Promise<Response>) | undefined
    const unregister = vi.fn(() => {})
    ctx.provide('connection', {
      fetch: {
        register: (registered: { fetch: (request: Request) => Promise<Response> }) => {
          handler = registered.fetch
          return unregister
        },
      },
    } as never)
    ctx.provide('workspaceRegistry', {
      list: () => [{ path: workspaceRoot }],
    } as never)
    await ctx.plugin(SessionMediaReferences).await()
    const fetchFile = (request: Request) => {
      if (handler === undefined) throw new Error('route not registered')
      return handler(request)
    }
    return {
      call: (path, init) => {
        const url = `http://127.0.0.1:3080/api/file?path=${encodeURIComponent(path)}`
        return fetchFile(new Request(url, init))
      },
      raw: (url, init) => fetchFile(new Request(url, init)),
      unregister,
      dispose: () => ctx.fiber.dispose().then(() => {
        const index = contexts.indexOf(ctx)
        if (index >= 0) contexts.splice(index, 1)
      }),
    }
  }

  it('serves images from the workspace root and nested directories', async () => {
    const route = await mount()
    const direct = join(root, 'graph.png')
    await writeFile(direct, PNG_BYTES)
    const response = await route.call(direct)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await responseBytes(response)).toEqual(PNG_BYTES)

    const nestedDir = join(root, 'shots', 'deep')
    await mkdir(nestedDir, { recursive: true })
    const nested = join(nestedDir, 'x.png')
    await writeFile(nested, PNG_BYTES)
    expect((await route.call(nested)).status).toBe(200)
  })

  it('serves every allowlisted media category by extension', async () => {
    const route = await mount()
    const video = join(root, 'clip.mp4')
    await writeFile(video, MP4_BYTES)
    const videoResponse = await route.call(video)
    expect(videoResponse.status).toBe(200)
    expect(videoResponse.headers.get('content-type')).toBe('video/mp4')

    const audio = join(root, 'song.mp3')
    await writeFile(audio, TEXT_BYTES)
    const audioResponse = await route.call(audio)
    expect(audioResponse.status).toBe(200)
    expect(audioResponse.headers.get('content-type')).toBe('audio/mpeg')
  })

  it('serves allowlisted image extensions regardless of payload bytes', async () => {
    // Media bytes are never sniffed on this route: a corrupt payload fails
    // in the browser, not here.
    const route = await mount()
    const fake = join(root, 'fake.png')
    await writeFile(fake, TEXT_BYTES)
    const response = await route.call(fake)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
  })

  it('refuses non-media, unknown, and denied content types', async () => {
    const route = await mount()
    const cases: ReadonlyArray<[string, Uint8Array]> = [
      ['note.txt', TEXT_BYTES],
      ['run.exe', TEXT_BYTES],
      ['logo.svg', TEXT_BYTES],
      ['data.bin', TEXT_BYTES],
      ['README', TEXT_BYTES],
    ]
    for (const [name, bytes] of cases) {
      const path = join(root, name)
      await writeFile(path, bytes)
      const response = await route.call(path)
      expect(response.status, name).toBe(415)
      expect(await response.text()).toBe('not an allowlisted media type')
    }
  })

  it('answers bounded, open-ended, suffix, and clamped range requests', async () => {
    const route = await mount()
    const path = join(root, 'graph.png')
    await writeFile(path, PNG_BYTES)
    const total = PNG_BYTES.length

    const bounded = await route.call(path, { headers: { range: 'bytes=0-3' } })
    expect(bounded.status).toBe(206)
    expect(bounded.headers.get('content-range')).toBe(`bytes 0-3/${total}`)
    expect(bounded.headers.get('content-length')).toBe('4')
    expect(await responseBytes(bounded)).toEqual(PNG_BYTES.slice(0, 4))

    const suffix = await route.call(path, { headers: { range: 'bytes=-4' } })
    expect(suffix.status).toBe(206)
    expect(await responseBytes(suffix)).toEqual(PNG_BYTES.slice(-4))

    const openEnded = await route.call(path, { headers: { range: 'bytes=4-' } })
    expect(openEnded.status).toBe(206)
    expect(await responseBytes(openEnded)).toEqual(PNG_BYTES.slice(4))

    const clamped = await route.call(path, { headers: { range: 'bytes=6-999' } })
    expect(clamped.status).toBe(206)
    expect(clamped.headers.get('content-range')).toBe(`bytes 6-${total - 1}/${total}`)
    expect(await responseBytes(clamped)).toEqual(PNG_BYTES.slice(6))
  })

  it('answers unsatisfiable ranges with 416 and the total size', async () => {
    const route = await mount()
    const path = join(root, 'graph.png')
    await writeFile(path, PNG_BYTES)
    const response = await route.call(path, { headers: { range: 'bytes=999-' } })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${PNG_BYTES.length}`)
  })

  it('ignores malformed and unknown-unit ranges for a full 200 body', async () => {
    const route = await mount()
    const path = join(root, 'graph.png')
    await writeFile(path, PNG_BYTES)
    for (const range of ['bytes=abc', 'items=0-0']) {
      const response = await route.call(path, { headers: { range } })
      expect(response.status, range).toBe(200)
      expect(response.headers.get('content-range')).toBeNull()
      expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
      expect(await responseBytes(response), range).toEqual(PNG_BYTES)
    }
  })

  it('ignores multi-range headers and serves the full 200 body', async () => {
    const route = await mount()
    const path = join(root, 'graph.png')
    await writeFile(path, PNG_BYTES)
    const response = await route.call(path, { headers: { range: 'bytes=0-1,3-4' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.headers.get('content-range')).toBeNull()
    expect(await responseBytes(response)).toEqual(PNG_BYTES)
  })

  it('answers HEAD without a body', async () => {
    const route = await mount()
    const path = join(root, 'graph.png')
    await writeFile(path, PNG_BYTES)
    const response = await route.call(path, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.headers.get('content-range')).toBeNull()
    expect(response.body).toBeNull()

    const ranged = await route.call(path, { method: 'HEAD', headers: { range: 'bytes=0-3' } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-3/${PNG_BYTES.length}`)
    expect(ranged.headers.get('content-length')).toBe('4')
    expect(ranged.body).toBeNull()
  })

  it('answers HEAD errors without a body', async () => {
    const route = await mount()
    const response = await route.raw('http://127.0.0.1:3080/api/file', { method: 'HEAD' })
    expect(response.status).toBe(400)
    expect(response.body).toBeNull()
  })

  it('denies malformed, missing, empty, and uncontained requests', async () => {
    const route = await mount()
    expect((await route.raw('http://127.0.0.1:3080/api/file')).status).toBe(400)
    expect((await route.raw('http://127.0.0.1:3080/api/file?path=')).status).toBe(400)
    expect((await route.raw(`http://127.0.0.1:3080/api/file?path=${encodeURIComponent('x.png')}`)).status)
      .toBe(400)
    expect((await route.raw(`http://127.0.0.1:3080/api/file?path=${encodeURIComponent('/a\0b.png')}`)).status)
      .toBe(400)
    expect((await route.call(join(root, 'missing.png'))).status).toBe(404)

    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-media-references-out-')))
    const path = join(outside, 'x.png')
    await writeFile(path, PNG_BYTES)
    try {
      const denied = await route.call(path)
      expect(denied.status).toBe(403)
      expect(await denied.text()).toBe('outside workspace roots')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  // A FIFO would block a plain open; the pre-open regular-file check refuses
  // it first. POSIX-only because Windows has no named-pipe path construction
  // here.
  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO named as media without blocking on the open',
    async () => {
      const route = await mount()
      const pipe = join(root, 'stream.png')
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      await promisify(execFile)('mkfifo', [pipe])
      const response = await route.call(pipe)
      expect(response.status).toBe(403)
      expect(await response.text()).toBe('not a regular file')
    },
  )

  it('answers 404 when an existing file cannot be opened for reading', async () => {
    // A permission-less file passes realpath/stat but fails the open; the
    // route treats the unreadable file like a missing one. chmod has no
    // effect on Windows, where this case is skipped.
    if (process.platform === 'win32') return
    const route = await mount()
    const path = join(root, 'locked.png')
    await writeFile(path, PNG_BYTES)
    const { chmod } = await import('node:fs/promises')
    await chmod(path, 0o000)
    try {
      const response = await route.call(path)
      expect(response.status).toBe(404)
    } finally {
      await chmod(path, 0o600)
    }
  })

  it('refuses a directory even when its name carries a media extension', async () => {
    const route = await mount()
    const directory = join(root, 'frames.png')
    await mkdir(directory)
    const response = await route.call(directory)
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('not a regular file')
  })

  // A POSIX filesystem root is the separator itself; the Windows drive-root
  // spelling cannot be produced portably, so the case stays POSIX-only. The
  // containment code treats any separator-terminated root the same way.
  it.skipIf(process.platform === 'win32')(
    'serves files when the registered workspace is the filesystem root',
    async () => {
      const route = await mount(sep)
      const path = join(root, 'graph.png')
      await writeFile(path, PNG_BYTES)
      const response = await route.call(path)
      expect(response.status).toBe(200)
      expect(await responseBytes(response)).toEqual(PNG_BYTES)
    },
  )

  it('follows symlinks for the containment check', async () => {
    const route = await mount()
    const real = join(root, 'real.png')
    await writeFile(real, PNG_BYTES)
    const link = join(root, 'link.png')
    await symlink(real, link)
    expect((await route.call(link)).status).toBe(200)

    // The escaping target lives in a private directory so concurrent test
    // processes can never share or delete it.
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-media-references-target-')))
    const outsideTarget = join(outside, 'secret.png')
    await writeFile(outsideTarget, PNG_BYTES)
    try {
      const escaping = join(root, 'escape.png')
      await symlink(outsideTarget, escaping)
      const denied = await route.call(escaping)
      expect(denied.status).toBe(403)
      expect(await denied.text()).toBe('outside workspace roots')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('streams a slice of a large sparse file without buffering it whole', async () => {
    const route = await mount()
    const path = join(root, 'huge.mp4')
    const handle = await open(path, 'w')
    try {
      await handle.truncate(256 * 1024 * 1024)
    } finally {
      await handle.close()
    }
    const response = await route.call(path, { headers: { range: 'bytes=0-9' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe('10')
    expect((await responseBytes(response)).length).toBe(10)
  })

  it('closes the file stream when the client aborts mid-response', async () => {
    const route = await mount()
    const path = join(root, 'huge.mp4')
    const handle = await open(path, 'w')
    try {
      await handle.truncate(64 * 1024 * 1024)
    } finally {
      await handle.close()
    }
    const controller = new AbortController()
    const response = await route.call(path, { signal: controller.signal })
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    await reader?.read()
    controller.abort()
    // The abort listener destroys the underlying file stream; reading the web
    // stream then fails instead of draining the remaining 64 MiB.
    await expect(reader?.read()).rejects.toBeTruthy()
  })

  it('destroys the stream immediately for an already-aborted request', async () => {
    const route = await mount()
    const path = join(root, 'huge.mp4')
    const handle = await open(path, 'w')
    try {
      await handle.truncate(16 * 1024 * 1024)
    } finally {
      await handle.close()
    }
    const controller = new AbortController()
    controller.abort()
    const response = await route.call(path, { signal: controller.signal })
    expect(response.status).toBe(200)
    // No stream is opened for a client that is already gone.
    expect(response.body).toBeNull()
  })

  it('unregisters the route when the contribution is disposed', async () => {
    const route = await mount()
    expect(route.unregister).not.toHaveBeenCalled()
    await route.dispose()
    expect(route.unregister).toHaveBeenCalledTimes(1)
  })
})
