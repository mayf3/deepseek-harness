import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
}

describe('SessionMediaReferences /api/file', () => {
  let root: string
  let route: MountedRoute
  const contexts: Context[] = []

  beforeEach(async () => {
    // Real workspace roots are canonical; tmpdir may sit behind a symlink.
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-media-references-')))
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
    ctx.provide('workspaceRegistry', { list: () => [{ path: root }] } as never)
    await ctx.plugin(SessionMediaReferences).await()
    const fetchFile = (request: Request) => {
      if (handler === undefined) throw new Error('route not registered')
      return handler(request)
    }
    route = {
      call: (path, init) => {
        const url = `http://127.0.0.1:3080/api/file?path=${encodeURIComponent(path)}`
        return fetchFile(new Request(url, init))
      },
      raw: (url, init) => fetchFile(new Request(url, init)),
      unregister,
    }
  })

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await rm(root, { recursive: true, force: true })
  })

  it('serves images from the workspace root and nested directories', async () => {
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
    const fake = join(root, 'fake.png')
    await writeFile(fake, TEXT_BYTES)
    const response = await route.call(fake)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
  })

  it('refuses non-media, unknown, and denied content types', async () => {
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

  it('answers unsatisfiable and malformed ranges with 416 and the total size', async () => {
    const path = join(root, 'graph.png')
    await writeFile(path, PNG_BYTES)
    for (const range of ['bytes=999-', 'bytes=abc']) {
      const response = await route.call(path, { headers: { range } })
      expect(response.status, range).toBe(416)
      expect(response.headers.get('content-range')).toBe(`bytes */${PNG_BYTES.length}`)
    }
  })

  it('answers HEAD without a body', async () => {
    const path = join(root, 'graph.png')
    await writeFile(path, PNG_BYTES)
    const response = await route.call(path, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.body).toBeNull()
  })

  it('denies malformed, missing, and uncontained requests', async () => {
    expect((await route.raw('http://127.0.0.1:3080/api/file')).status).toBe(400)
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

  it('refuses the workspace-root directory itself', async () => {
    const response = await route.call(root)
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('not a regular file')
  })

  it('follows symlinks for the containment check', async () => {
    const real = join(root, 'real.png')
    await writeFile(real, PNG_BYTES)
    const link = join(root, 'link.png')
    await symlink(real, link)
    expect((await route.call(link)).status).toBe(200)

    const outsideTarget = join(await realpath(tmpdir()), 'dsh-media-references-target.png')
    await writeFile(outsideTarget, PNG_BYTES)
    try {
      const escaping = join(root, 'escape.png')
      await symlink(outsideTarget, escaping)
      const denied = await route.call(escaping)
      expect(denied.status).toBe(403)
      expect(await denied.text()).toBe('outside workspace roots')
    } finally {
      await rm(outsideTarget, { force: true })
    }
  })

  it('streams a slice of a large sparse file without buffering it whole', async () => {
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

  it('keeps the route registered until the contribution is disposed', () => {
    expect(route.unregister).not.toHaveBeenCalled()
  })
})
