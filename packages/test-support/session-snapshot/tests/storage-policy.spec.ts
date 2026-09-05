import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { assertSessionFixtureStorage } from '../src/suite.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const system = { type: 'system/message', data: { message: {
  role: 'system', content: [{ type: 'text', text: '{{system}}' }],
} } }
const request = { type: 'request/header', data: { header: { tools: '{{tools}}' } } }

function fixture(id: number, version: number, events: unknown[]): string {
  return [{ type: 'session', version, id: `{{session:${id}}}`, createdAt: 0, delegationDepth: id - 1 }, ...events]
    .map(record => JSON.stringify(record)).join('\n') + '\n'
}

function registerGuard(childEvents: unknown[]): () => Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-storage-policy-'))
  roots.push(root)
  const dir = join(root, 'pin')
  mkdirSync(dir)
  writeFileSync(join(dir, 'session.v2.jsonl'), fixture(1, 2, [system, request]))
  // Each role selects its highest generation; the older child deliberately violates the policy.
  writeFileSync(join(dir, 'session.1.v1.jsonl'), fixture(2, 1, [request]))
  writeFileSync(join(dir, 'session.1.v2.jsonl'), fixture(2, 2, childEvents))
  return () => assertSessionFixtureStorage(dir, 'pin')
}

test('checks only the highest generation of every parent and child role', async () => {
  await expect(registerGuard([system, request])()).resolves.toBeUndefined()
})

test.each([
  ['missing prompt', [request], 'has a request/header with no preceding system/message'],
  ['unscrubbed prompt', [{ ...system, data: { message: {
    role: 'system', content: [{ type: 'text', text: 'leaked child prompt' }],
  } } }, request], 'carries an unscrubbed system prompt'],
  ['unscrubbed tools', [system, { type: 'request/header', data: { header: { tools: [] } } }], 'carries unscrubbed tool schemas'],
] as const)('rejects a selected child with %s', async (_name, events, message) => {
  await expect(registerGuard([...events])()).rejects.toThrow(`pin/session.1.v2.jsonl ${message}`)
})
