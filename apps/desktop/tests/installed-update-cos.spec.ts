import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInstalledUpdateCos } from '../scripts/installed-update-cos.ts'

interface Request {
  method: string
  path: string
  headers: Record<string, string>
  body?: string | AsyncIterable<Uint8Array>
}
const state = vi.hoisted(() => ({ requests: [] as Request[], status: 200, versioning: '', settings: 'test', maxAttempts: 0 }))
vi.mock('../scripts/desktop-package-environment.mjs', () => ({ loadDesktopPackageEnvironment: () => ({
  DSH_DESKTOP_AUTO_UPDATE_ENV: state.settings, DOWNLOAD_TEST_ORIGIN: 'https://download-test.deepseek.com',
  DOWNLOAD_TEST_COS_BUCKET: 'bj-toc-download-test-1320056602', DOWNLOAD_TEST_COS_SECRET_ID: 'fixture-id',
  DOWNLOAD_TEST_COS_SECRET_KEY: 'fixture-key', DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'fixture-pin-not-for-sdk',
}) }))
vi.mock('@aws-sdk/client-s3', async (original) => {
  const actual = await original<typeof import('@aws-sdk/client-s3')>()
  const { Readable } = await import('node:stream')
  return { ...actual, S3Client: class extends actual.S3Client {
    constructor(options: ConstructorParameters<typeof actual.S3Client>[0]) {
      expect(options?.credentials).toEqual({ accessKeyId: 'fixture-id', secretAccessKey: 'fixture-key' })
      state.maxAttempts = options?.maxAttempts as number
      super({ ...options, requestHandler: { handle: async (request: unknown) => {
        const req = request as Request
        state.requests.push(req)
        if (req.body && typeof req.body !== 'string') for await (const _bytes of req.body) { /* Consume the owned request stream. */ }
        const text = state.status === 200 ? req.method === 'PUT' ? ''
          : req.path.includes('/dsh-desk/') ? 'object bytes'
            : `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${state.versioning}</VersioningConfiguration>`
          : `<Error><Code>${state.status === 404 ? 'NoSuchKey' : 'AccessDenied'}</Code><Message>fixture</Message></Error>`
        return { response: { statusCode: state.status, headers: { 'x-amz-request-id': 'fixture-request' }, body: Readable.from([Buffer.from(text)]) } }
      } } })
    }
  } }
})
afterEach(() => { state.requests.length = 0; state.status = 200; state.versioning = ''; state.settings = 'test'; vi.unstubAllGlobals() })
const key = `dsh-desk/bin/qualification/${'a'.repeat(24)}/win-x64/package.exe`

describe('qualification COS transport with real SDK serialization and substituted HTTP', () => {
  it('sends explicit non-overwrite and MD5 headers without retrying or passing signing credentials', async () => {
    const store = createInstalledUpdateCos()
    try {
      expect(state.requests).toHaveLength(0)
      expect(await store.versioningDisabled()).toBe(true)
      expect(await store.put(key, { source: { contents: 'bytes' }, size: 5,
        sha512: createHash('sha512').update('bytes').digest('base64'), forbidOverwrite: true })).toEqual({ requestId: 'fixture-request' })
      const request = state.requests.at(-1)!
      expect(request.headers['x-cos-forbid-overwrite']).toBe('true')
      expect(request.headers.authorization).toContain('x-cos-forbid-overwrite')
      expect(request.headers['content-md5']).toBe(createHash('md5').update('bytes').digest('base64'))
      expect(request.headers['cache-control']).toBe('no-store')
      expect(JSON.stringify(request.headers)).not.toContain('fixture-pin')
      expect(state.maxAttempts).toBe(1)
    } finally { store.dispose() }
  })

  it.each(['<Status>Enabled</Status>', '<Status>Suspended</Status>'])('does not authorize overwrites for %s', async (versioning) => {
    state.versioning = versioning
    const store = createInstalledUpdateCos()
    try { expect(await store.versioningDisabled()).toBe(false) } finally { store.dispose() }
  })

  it('does not retry an uncertain PUT failure', async () => {
    state.status = 500
    const store = createInstalledUpdateCos()
    try {
      await expect(store.put(key, { source: { contents: 'x' }, size: 1,
        sha512: createHash('sha512').update('x').digest('base64'), forbidOverwrite: true })).rejects.toThrow()
      expect(state.requests).toHaveLength(1)
    } finally { store.dispose() }
  })

  it('distinguishes confirmed object absence from permission errors', async () => {
    const store = createInstalledUpdateCos()
    try {
      expect(await store.read(key)).toEqual({ size: 12, sha512: createHash('sha512').update('object bytes').digest('base64') })
      state.status = 404
      expect(await store.read(key)).toBeNull()
      state.status = 403
      await expect(store.read(key)).rejects.toThrow()
    } finally { store.dispose() }
  })

  it('hashes public response bytes at the exact URL and rejects redirects or unrelated destinations', async () => {
    const fetch = vi.fn(async () => new Response('public bytes'))
    vi.stubGlobal('fetch', fetch)
    const store = createInstalledUpdateCos()
    try {
      const url = `https://download-test.deepseek.com/${key}`
      expect(await store.publicRead(url)).toEqual({ size: 12, sha512: createHash('sha512').update('public bytes').digest('base64') })
      expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error', cache: 'no-store' }))
      await expect(store.publicRead(`${url}?fresh=1`)).rejects.toThrow('exact test public URL')
      await expect(store.publicRead(url.replace('download-test', 'download'))).rejects.toThrow('exact test public URL')
      await expect(store.read('dsh-desk/feeds/nightly.yml')).rejects.toThrow('qualification namespace')
    } finally { store.dispose() }
  })

  it('refuses production settings without creating a request', () => {
    state.settings = 'production'
    expect(() => createInstalledUpdateCos()).toThrow('test upload settings')
    expect(state.requests).toHaveLength(0)
  })

  it('rejects mismatched upload bytes and unsafe keys before sending a request', async () => {
    const store = createInstalledUpdateCos()
    try {
      await expect(store.put(key, { source: { contents: 'changed' }, size: 1, sha512: 'wrong', forbidOverwrite: true }))
        .rejects.toThrow('input bytes changed')
      await expect(store.read(key.replace('package.exe', '..'))).rejects.toThrow('qualification namespace')
      expect(state.requests).toHaveLength(0)
    } finally { store.dispose() }
  })
})
