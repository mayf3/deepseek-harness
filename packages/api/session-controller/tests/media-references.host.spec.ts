import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  SessionMediaReferences,
  serveMediaReference,
  mediaTypeForPath,
  parseByteRange,
  type MediaReferenceRegistry,
} from '../src/media-references.ts'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6])
const TEXT_BYTES = new Uint8Array([1, 2, 3, 4])
const MP4_BYTES = new TextEncoder().encode('....ftypmp42....moov....')

function registry(root: string): MediaReferenceRegistry {
  return { list: () => [{ path: root }] }
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer())
}

function apiRequest(path: string, init?: RequestInit): Request {
  const url = `http://127.0.0.1:3080/api/file?path=${encodeURIComponent(path)}`
  return new Request(url, init)
}

describe('mediaTypeForPath', () => {
  it('maps allowlisted media extensions', () => {
    expect(mediaTypeForPath('/w/graph.png')).toBe('image/png')
    expect(mediaTypeForPath('/w/graph.jpg')).toBe('image/jpeg')
    expect(mediaTypeForPath('/w/clip.mp4')).toBe('video/mp4')
    expect(mediaTypeForPath('/w/clip.webm')).toBe('video/webm')
    expect(mediaTypeForPath('/w/song.mp3')).toBe('audio/mpeg')
  })

  it('refuses non-media extensions', () => {
    expect(mediaTypeForPath('/w/note.txt')).toBeUndefined()
    expect(mediaTypeForPath('/w/app.exe')).toBeUndefined()
    expect(mediaTypeForPath('/w/shell.svg')).toBeUndefined()
  })
})

describe('parseByteRange', () => {
  it('parses full, bounded, open-ended, and suffix ranges', () => {
    expect(parseByteRange(null, 100)).toEqual({ kind: 'full' })
    expect(parseByteRange('bytes=0-3', 100)).toEqual({ kind: 'partial', start: 0, end: 3 })
    expect(parseByteRange('bytes=10-', 100)).toEqual({ kind: 'partial', start: 10, end: 99 })
    expect(parseByteRange('bytes=-4', 100)).toEqual({ kind: 'partial', start: 96, end: 99 })
    expect(parseByteRange('bytes=90-200', 100)).toEqual({ kind: 'partial', start: 90, end: 99 })
  })

  it('refuses malformed and unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=abc', 100)).toBeUndefined()
    expect(parseByteRange('bytes=5-2', 100)).toBeUndefined()
    expect(parseByteRange('bytes=100-', 100)).toBeUndefined()
    expect(parseByteRange('bytes=0-', 0)).toBeUndefined()
  })
})

describe('serveMediaReference', () => {
  let root: string

  beforeEach(async () => {
    // Real workspace roots are canonical; tmpdir may sit behind a symlink.
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-file-')))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('serves a workspace image with streaming-safe headers', async () => {
    const path = join(root, 'shots', 'graph.png')
    await mkdir(join(root, 'shots'), { recursive: true })
    await writeFile(path, PNG_BYTES)
    const response = await serveMediaReference(apiRequest(path), registry(root))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await responseBytes(response)).toEqual(PNG_BYTES)
  })

  it('serves media without image sniffing from the extension allowlist', async () => {
    const path = join(root, 'clip.mp4')
    await writeFile(path, MP4_BYTES)
    const response = await serveMediaReference(apiRequest(path), registry(root))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(await responseBytes(response)).toEqual(MP4_BYTES)
  })

  it('answers bounded and suffix range requests with 206 slices', async () => {
    const path = join(root, 'graph.png')
    await writeFile(path, PNG_BYTES)
    const bounded = await serveMediaReference(
      apiRequest(path, { headers: { range: 'bytes=0-3' } }),
      registry(root),
    )
    expect(bounded.status).toBe(206)
    expect(bounded.headers.get('content-range')).toBe(`bytes 0-3/${PNG_BYTES.length}`)
    expect(bounded.headers.get('content-length')).toBe('4')
    expect(await responseBytes(bounded)).toEqual(PNG_BYTES.slice(0, 4))

    const suffix = await serveMediaReference(
      apiRequest(path, { headers: { range: 'bytes=-4' } }),
      registry(root),
    )
    expect(suffix.status).toBe(206)
    expect(await responseBytes(suffix)).toEqual(PNG_BYTES.slice(-4))
  })

  it('answers unsatisfiable ranges with 416 and the total size', async () => {
    const path = join(root, 'graph.png')
    await writeFile(path, PNG_BYTES)
    const response = await serveMediaReference(
      apiRequest(path, { headers: { range: 'bytes=999-' } }),
      registry(root),
    )
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${PNG_BYTES.length}`)
  })

  it('answers HEAD without a body', async () => {
    const path = join(root, 'graph.png')
    await writeFile(path, PNG_BYTES)
    const response = await serveMediaReference(
      apiRequest(path, { method: 'HEAD' }),
      registry(root),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.body).toBeNull()
  })

  it('denies malformed, missing, and uncontained requests', async () => {
    const missing = await serveMediaReference(
      new Request('http://127.0.0.1:3080/api/file'),
      registry(root),
    )
    expect(missing.status).toBe(400)
    const relative = await serveMediaReference(
      new Request(`http://127.0.0.1:3080/api/file?path=${encodeURIComponent('x.png')}`),
      registry(root),
    )
    expect(relative.status).toBe(400)
    const gone = await serveMediaReference(
      apiRequest(join(root, 'missing.png')),
      registry(root),
    )
    expect(gone.status).toBe(404)
    expect((await serveMediaReference(apiRequest(join(root, 'x.png')), undefined)).status).toBe(403)

    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-file-out-')))
    const path = join(outside, 'x.png')
    await writeFile(path, PNG_BYTES)
    try {
      const denied = await serveMediaReference(apiRequest(path), registry(root))
      expect(denied.status).toBe(403)
      expect(await denied.text()).toBe('outside workspace roots')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses directories and non-allowlisted extensions', async () => {
    const directory = await serveMediaReference(apiRequest(root), registry(root))
    expect(directory.status).toBe(403)

    const text = join(root, 'note.txt')
    await writeFile(text, TEXT_BYTES)
    expect((await serveMediaReference(apiRequest(text), registry(root))).status).toBe(415)
  })

  it('serves allowlisted extensions regardless of payload bytes', async () => {
    // Media bytes are not sniffed here: the extension allowlist decides what
    // is served, and a corrupt image payload stays a browser-side failure.
    const fake = join(root, 'fake.png')
    await writeFile(fake, TEXT_BYTES)
    const response = await serveMediaReference(apiRequest(fake), registry(root))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
  })

  it('follows a symlink into the workspace for the containment check', async () => {
    const real = join(root, 'real.png')
    await writeFile(real, PNG_BYTES)
    const link = join(root, 'link.png')
    await symlink(real, link)
    const response = await serveMediaReference(apiRequest(link), registry(root))
    expect(response.status).toBe(200)
    expect(await responseBytes(response)).toEqual(PNG_BYTES)
  })

  it('survives a large sparse file check without buffering it whole', async () => {
    const path = join(root, 'huge.mp4')
    const handle = await open(path, 'w')
    try {
      await handle.truncate(256 * 1024 * 1024)
    } finally {
      await handle.close()
    }
    const response = await serveMediaReference(
      apiRequest(path, { headers: { range: 'bytes=0-9' } }),
      registry(root),
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe('10')
    expect((await responseBytes(response)).length).toBe(10)
  })
})

describe('SessionMediaReferences plugin contribution', () => {
  const roots: Context[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  it('registers the /api/file route when connection and registry are composed', async () => {
    const unregister = vi.fn(() => {})
    let registered: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Promise<Response>
    } | undefined
    const register = vi.fn((route: typeof registered) => {
      registered = route
      return unregister
    })
    const ctx = new Context()
    roots.push(ctx)
    ctx.provide('connection', { fetch: { register } } as never)
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    await ctx.plugin(SessionMediaReferences).await()

    expect(register).toHaveBeenCalledTimes(1)
    expect(registered?.path).toBe('/api/file')
    expect(registered?.methods).toEqual(['GET', 'HEAD'])
    expect(registered?.requestBody).toBe('buffered')

    // The composed route consults the composed registry: an empty registry
    // refuses an existing absolute path with the containment verdict.
    const existing = await realpath(tmpdir())
    const denied = await registered?.fetch(
      new Request(`http://127.0.0.1:3080/api/file?path=${encodeURIComponent(existing)}`),
    )
    expect(denied?.status).toBe(403)
    expect(await denied?.text()).toBe('outside workspace roots')

    await ctx.fiber.dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})
