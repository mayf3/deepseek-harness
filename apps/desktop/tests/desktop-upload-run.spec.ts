import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { S3Client } from '@aws-sdk/client-s3'
import { afterEach, describe, expect, it } from 'vitest'
import { uploadDesktopRelease } from '../scripts/desktop-upload-run.ts'
import type { DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(environment: 'test' | 'production' = 'test') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upload-audit-'))
  roots.push(root)
  const binary = join(root, 'package.exe')
  await writeFile(binary, 'binary fixture')
  const plan: DesktopUploadPlan = {
    environment, target: 'win-x64', version: '1.2.3', bucket: `${environment}-bucket`,
    publicUrl: `https://${environment}.invalid/feed/`, secretIdEnvName: 'UNREAD_ID', secretKeyEnvName: 'UNREAD_KEY',
    artifacts: [
      { path: binary, filename: 'package.exe', key: 'bin/package.exe', contentType: 'application/octet-stream', channelMetadata: false },
      { path: join(root, 'nightly.yml'), filename: 'nightly.yml', key: 'feeds/nightly.yml', contentType: 'application/yaml', channelMetadata: true,
        contents: 'version: 1.2.3\n' },
    ],
  }
  const records = join(root, 'records')
  const directory = async () => join(records, (await readdir(records))[0]!)
  return { root, records, plan, directory }
}

interface Request {
  path: string
  headers: Record<string, string>
  body?: string | AsyncIterable<Uint8Array>
}

function client(handle: (request: Request) => Promise<number>, maxAttempts = 1) {
  return new S3Client({ region: 'Auto', endpoint: 'https://cos.invalid', maxAttempts,
    credentials: { accessKeyId: 'test-credential-id', secretAccessKey: 'test-credential-secret' },
    requestHandler: { handle: async (input: unknown) => {
      const request = input as Request
      if (request.body && typeof request.body !== 'string') for await (const _bytes of request.body) { /* Drain this request's owned stream. */ }
      const statusCode = await handle(request)
      return { response: { statusCode, headers: { 'x-amz-request-id': 'fixture-request' }, body: Readable.from([
        Buffer.from(statusCode === 200 ? '' : '<Error><Code>InternalError</Code><Message>test-credential-secret</Message></Error>'),
      ]) } }
    } },
  })
}

interface RecordedPlan {
  environment: string
  artifacts: { contents?: string; md5: string; sha512: string }[]
  sourceSha256: Record<string, string>
}

async function json<T = unknown>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T }

async function journal(path: string): Promise<{ type: string; time: string }[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; time: string })
}

describe('release upload audit with real SDK and isolated HTTP replacement', () => {
  it.each(['test', 'production'] as const)('retains %s plan, feed bytes, intent, receipt and hashes before advancing', async (environment) => {
    const f = await fixture(environment)
    const requests: Request[] = []
    const transport = client(async (request) => {
      requests.push(request)
      const directory = await f.directory()
      const plan = await json<RecordedPlan>(join(directory, 'plan.json'))
      expect(plan.environment).toBe(environment)
      expect(plan.artifacts[1]!.contents).toBe('version: 1.2.3\n')
      const lines = await journal(join(directory, 'events.jsonl'))
      expect(lines.at(-1)).toMatchObject({ type: 'put-intent', key: f.plan.artifacts[requests.length - 1]!.key })
      expect(request.headers['content-md5']).toBe(plan.artifacts[requests.length - 1]!.md5)
      return 200
    })
    try {
      const directory = await uploadDesktopRelease(f.plan, transport, f.records)
      expect(requests).toHaveLength(2)
      const plan = await json<RecordedPlan>(join(directory, 'plan.json'))
      expect(plan.artifacts[0]!.sha512).toBe(createHash('sha512').update('binary fixture').digest('base64'))
      expect(plan.sourceSha256['upload-target.ts']).toBe(createHash('sha256')
        .update(await readFile(join(import.meta.dirname, '../scripts/upload-target.ts'))).digest('hex'))
      const result = await json(join(directory, 'result.json'))
      expect(result).toMatchObject({ success: true, stage: 'complete', confirmedPuts: 2, publicReadback: 'not-performed' })
      const events = await journal(join(directory, 'events.jsonl'))
      expect(`${events.map(event => event.type).join('\n')}\n`).toBe(await readFile(join(import.meta.dirname, 'expected/desktop-upload-audit.txt'), 'utf8'))
      expect(events[2]).toMatchObject({ httpStatus: 200, requestId: 'fixture-request', attempts: 1 })
      for (const event of events) expect(Number.isFinite(Date.parse(event.time))).toBe(true)
      expect(JSON.stringify({ plan, result, events })).not.toMatch(/test-credential|authorization|UNREAD_KEY/iu)
    } finally { transport.destroy() }
  })

  it.each([1, 2])('retains failure at PUT %s without retry or later upload, excluding raw SDK diagnostics', async (failAt) => {
    const f = await fixture()
    let requests = 0
    const transport = client(async () => { requests++; return requests === failAt ? 500 : 200 })
    try {
      await expect(uploadDesktopRelease(f.plan, transport, f.records)).rejects.toThrow('stopped at put')
      expect(requests).toBe(failAt)
      const directory = await f.directory()
      const result = await json(join(directory, 'result.json'))
      expect(result).toMatchObject({ success: false, confirmedPuts: failAt - 1, stage: 'put', failure: { errorCode: 'InternalError', httpStatus: 500, requestId: 'fixture-request' } })
      expect(await readFile(join(directory, 'result.json'), 'utf8')).not.toContain('test-credential-secret')
      expect((await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(failAt * 2)
    } finally { transport.destroy() }
  })

  it('refuses networking when the audit parent cannot be created or retries are enabled', async () => {
    const f = await fixture()
    let requests = 0
    const transport = client(async () => { requests++; return 200 }, 3)
    try {
      await expect(uploadDesktopRelease(f.plan, transport, f.plan.artifacts[0]!.path)).rejects.toThrow()
      await expect(uploadDesktopRelease(f.plan, transport, f.records)).rejects.toThrow('stopped at prepare')
      expect(requests).toBe(0)
      expect(await json(join(await f.directory(), 'result.json'))).toMatchObject({ success: false, confirmedPuts: 0 })
    } finally { transport.destroy() }
  })

  it('stops before the next PUT when a response cannot be recorded', async () => {
    const f = await fixture()
    let requests = 0
    const transport = client(async () => {
      requests++
      const directory = await f.directory()
      await rename(join(directory, 'events.jsonl'), join(directory, 'events-before-failure.jsonl'))
      await mkdir(join(directory, 'events.jsonl'))
      return 200
    })
    try {
      await expect(uploadDesktopRelease(f.plan, transport, f.records)).rejects.toThrow('stopped at record-response')
      expect(requests).toBe(1)
      expect(await json(join(await f.directory(), 'result.json'))).toMatchObject({ success: false, stage: 'record-response', confirmedPuts: 1 })
    } finally { transport.destroy() }
  })

  it('keeps independent runs without overwriting prior evidence', async () => {
    const f = await fixture()
    const transport = client(async () => 200)
    try {
      const first = await uploadDesktopRelease(f.plan, transport, f.records)
      const before = await readFile(join(first, 'result.json'), 'utf8')
      const second = await uploadDesktopRelease(f.plan, transport, f.records)
      expect(second).not.toBe(first)
      expect(await readFile(join(first, 'result.json'), 'utf8')).toBe(before)
    } finally { transport.destroy() }
  })
})
