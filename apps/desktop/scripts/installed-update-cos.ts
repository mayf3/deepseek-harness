/** Fixed test-COS transport; callers authorize writes separately from local planning. */
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { GetBucketVersioningCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import type { InstalledUpdatePublicationStore, InstalledUpdateRemoteObject } from './installed-update-publication.ts'

const BUCKET = 'bj-toc-download-test-1320056602'
const ORIGIN = 'https://download-test.deepseek.com'

async function hashStream(stream: AsyncIterable<Uint8Array>): Promise<InstalledUpdateRemoteObject> {
  const hash = createHash('sha512')
  let size = 0
  for await (const bytes of stream) { hash.update(bytes); size += bytes.length }
  return { sha512: hash.digest('base64'), size }
}

/**
 * Create a fixed test transport from .env.windows, passing only test upload credentials to the SDK.
 * @returns Store and explicit disposal; no request is sent by construction and no signing process is launched.
 */
export function createInstalledUpdateCos(): InstalledUpdatePublicationStore & { dispose(): void } {
  const environment = loadDesktopPackageEnvironment('win32')
  if (environment.DSH_DESKTOP_AUTO_UPDATE_ENV !== 'test' || environment.DOWNLOAD_TEST_ORIGIN !== ORIGIN
    || environment.DOWNLOAD_TEST_COS_BUCKET !== BUCKET || !environment.DOWNLOAD_TEST_COS_SECRET_ID?.trim()
    || !environment.DOWNLOAD_TEST_COS_SECRET_KEY?.trim()) throw new Error('installed update: complete test upload settings are required')
  const client = new S3Client({ region: 'Auto', endpoint: 'https://cos.ap-beijing.myqcloud.com', maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: environment.DOWNLOAD_TEST_COS_SECRET_ID, secretAccessKey: environment.DOWNLOAD_TEST_COS_SECRET_KEY } })
  const keyAllowed = (key: string): void => {
    if (!/^dsh-desk\/(?:bin|feeds)\/qualification\/[a-f0-9]{24}\/win-x64\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key)) {
      throw new Error('installed update: COS key must stay in the Windows qualification namespace')
    }
  }
  return {
    async versioningDisabled() {
      const response = await client.send(new GetBucketVersioningCommand({ Bucket: BUCKET }), { abortSignal: AbortSignal.timeout(30_000) })
      return response.$metadata.httpStatusCode === 200 && response.Status === undefined
    },
    async read(key) {
      keyAllowed(key)
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
          abortSignal: AbortSignal.timeout(900_000),
        })
        if (!response.Body) throw new Error('installed update: missing COS response body')
        // This transport uses the Node S3 handler, whose body is an async-iterable stream.
        return await hashStream(response.Body as AsyncIterable<Uint8Array>)
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'NoSuchKey') return null
        throw error
      }
    },
    async publicRead(url) {
      const parsed = new URL(url)
      if (parsed.origin !== ORIGIN || parsed.search || parsed.hash) throw new Error('installed update: exact test public URL is required')
      keyAllowed(parsed.pathname.slice(1))
      const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(900_000) })
      if (response.status === 404) { await response.body?.cancel(); return null }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('installed update: public object read failed') }
      const reader = response.body.getReader()
      async function* bytes() {
        try {
          for (;;) { const next = await reader.read(); if (next.done) return; yield next.value }
        } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
      }
      return hashStream(bytes())
    },
    async put(key, object) {
      keyAllowed(key)
      const md5 = createHash('md5')
      const sha512 = createHash('sha512')
      let size = 0
      const add = (bytes: Buffer): void => { md5.update(bytes); sha512.update(bytes); size += bytes.length }
      if ('path' in object.source) {
        for await (const bytes of createReadStream(object.source.path)) add(bytes as Buffer)
      } else add(Buffer.from(object.source.contents))
      if (size !== object.size || sha512.digest('base64') !== object.sha512) {
        throw new Error('installed update: upload input bytes changed')
      }
      const body = 'path' in object.source ? createReadStream(object.source.path) : object.source.contents
      const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentLength: object.size,
        ContentMD5: md5.digest('base64'), ContentType: key.endsWith('.yml') ? 'application/yaml' : 'application/octet-stream',
        CacheControl: 'no-store' })
      if (object.forbidOverwrite) command.middlewareStack.add(next => async (args) => {
        // S3's serialize step supplies the HTTP request before this build middleware.
        const request = args.request as { headers: Record<string, string> }
        request.headers['x-cos-forbid-overwrite'] = 'true'
        return next(args)
      }, { step: 'build', name: 'qualificationForbidOverwrite' })
      try {
        const response = await client.send(command, { abortSignal: AbortSignal.timeout(900_000) })
        return response.$metadata.requestId === undefined ? {} : { requestId: response.$metadata.requestId }
      } finally { if (typeof body !== 'string') body.destroy() }
    },
    dispose() { client.destroy() },
  }
}
