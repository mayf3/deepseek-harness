import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId } from '../src/file-id.ts'
import { deepSeekFileScope, DeepSeekUploadIndex } from '../src/upload-index.ts'

const ATTACHMENT = AttachmentId(`sha256:${'a'.repeat(64)}`)
const VARIANT = ImageVariantId(`sha256:${'b'.repeat(64)}`)

describe('DeepSeekUploadIndex', () => {
  it('isolates API-key namespaces and reuses only records above the refresh margin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    const first = deepSeekFileScope('https://api.deepseek.com', 'first-key')
    const second = deepSeekFileScope('https://api.deepseek.com', 'second-key')
    const record = {
      scope: first,
      masterAttachmentId: ATTACHMENT,
      variantId: VARIANT,
      fileId: DeepSeekFileId('file-api-one'),
      bytes: 3,
      createdAt: 1_000,
      expiresAt: 10_000,
    }

    await expect(index.commit(record, 1_000, 1_000)).resolves.toMatchObject({ accepted: true })
    await expect(index.get(first, VARIANT, 1_000, 1_000)).resolves.toEqual(record)
    await expect(index.get(second, VARIANT, 1_000, 1_000)).resolves.toBeUndefined()
    await expect(index.get(first, VARIANT, 9_000, 1_000)).resolves.toBeUndefined()
  })

  it('keeps a reusable cross-process winner and removes only an exact generation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    const scope = deepSeekFileScope('https://api.deepseek.com', 'key')
    const first = {
      scope, masterAttachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: DeepSeekFileId('file-api-first'), bytes: 3, createdAt: 1, expiresAt: 10_000,
    }
    const duplicate = { ...first, fileId: DeepSeekFileId('file-api-duplicate') }
    await index.commit(first, 1, 1)

    await expect(index.commit(duplicate, 2, 1)).resolves.toEqual({ record: first, accepted: false })
    await index.remove(scope, VARIANT, duplicate.fileId)
    await expect(index.get(scope, VARIANT, 2, 1)).resolves.toEqual(first)
    await index.remove(scope, VARIANT, first.fileId)
    await expect(index.get(scope, VARIANT, 2, 1)).resolves.toBeUndefined()
  })

  it('treats a corrupt upload cache as empty and repairs it on the next commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    const path = join(dir, 'index.json')
    await writeFile(path, '{bad', 'utf8')
    const index = new DeepSeekUploadIndex(path)
    const scope = deepSeekFileScope('https://api.deepseek.com', 'key')
    const record = {
      scope,
      masterAttachmentId: ATTACHMENT,
      variantId: VARIANT,
      fileId: DeepSeekFileId('file-api-repaired'),
      bytes: 3,
      createdAt: 1,
      expiresAt: 10_000,
    }

    await expect(index.get(scope, VARIANT, 1, 1)).resolves.toBeUndefined()
    await expect(index.commit(record, 1, 1)).resolves.toEqual({ record, accepted: true })
    await expect(index.get(scope, VARIANT, 1, 1)).resolves.toEqual(record)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ formatVersion: 2 })
  })
})
