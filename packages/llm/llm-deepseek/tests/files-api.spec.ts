import { describe, expect, it, vi } from 'vitest'
import { DeepSeekFileId } from '../src/file-id.ts'
import { DeepSeekFilesClient, isFilesQuotaError } from '../src/files-api.ts'

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-api-one',
    object: 'file',
    bytes: 3,
    created_at: 1_700_000_000,
    filename: 'image.png',
    purpose: 'user_data',
    expires_at: 1_700_604_800,
    ...overrides,
  }
}

describe('DeepSeekFilesClient', () => {
  it('uploads multipart bytes with the required purpose and explicit expiry', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(url)).toBe('https://api.deepseek.com/files')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer key')
      const form = init?.body
      expect(form).toBeInstanceOf(FormData)
      if (!(form instanceof FormData)) throw new Error('expected multipart body')
      expect(form.get('purpose')).toBe('user_data')
      expect(form.get('expires_after[anchor]')).toBe('created_at')
      expect(form.get('expires_after[seconds]')).toBe('604800')
      const blob = form.get('file')
      expect(blob).toBeInstanceOf(Blob)
      expect((blob as Blob).size).toBe(3)
      return new Response(JSON.stringify(file()), { status: 200 })
    }) as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com/', apiKey: 'key', fetch: fetchImpl })

    await expect(client.upload({
      data: Uint8Array.of(1, 2, 3),
      mediaType: 'image/png',
      filename: 'image.png',
      expiresAfterSeconds: 604_800,
    })).resolves.toEqual({
      id: DeepSeekFileId('file-api-one'),
      bytes: 3,
      createdAt: 1_700_000_000,
      filename: 'image.png',
      purpose: 'user_data',
      expiresAt: 1_700_604_800,
    })
  })

  it('validates list, retrieve, and delete responses', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = requestUrl(url)
      if (target.includes('?')) {
        return new Response(JSON.stringify({
          object: 'list', data: [file()], first_id: 'file-api-one', last_id: 'file-api-one', has_more: false,
        }), { status: 200 })
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ id: 'file-api-one', object: 'file', deleted: true }), { status: 200 })
      }
      return new Response(JSON.stringify(file()), { status: 200 })
    }) as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com', apiKey: 'key', fetch: fetchImpl })

    await expect(client.list({ limit: 20, order: 'desc' })).resolves.toMatchObject({
      data: [{ id: 'file-api-one' }], firstId: 'file-api-one', lastId: 'file-api-one', hasMore: false,
    })
    await expect(client.retrieve(DeepSeekFileId('file-api-one'))).resolves.toMatchObject({ id: 'file-api-one' })
    await expect(client.delete(DeepSeekFileId('file-api-one'))).resolves.toBeUndefined()
  })

  it('refuses an upload response that omits the requested expiry', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(
      JSON.stringify(file({ expires_at: undefined })),
      { status: 200 },
    ))) as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com', apiKey: 'key', fetch: fetchImpl })

    await expect(client.upload({
      data: Uint8Array.of(1), mediaType: 'image/png', filename: 'image.png', expiresAfterSeconds: 3_600,
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('retains quota error detail for the one cleanup retry policy', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: { message: 'user storage quota exceeded', type: 'invalid_request_error', code: 'file_quota' },
    }), { status: 400 }))) as typeof fetch
    const client = new DeepSeekFilesClient({ baseURL: 'https://api.deepseek.com', apiKey: 'key', fetch: fetchImpl })

    const error = await client.upload({
      data: Uint8Array.of(1), mediaType: 'image/png', filename: 'image.png', expiresAfterSeconds: 3_600,
    }).catch((caught: unknown) => caught)
    expect(isFilesQuotaError(error)).toBe(true)
  })
})
