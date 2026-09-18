/** Fault checks for the exploratory cache; these never call signing hardware. */
import { it as test, type TestContext } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createCachedSigner, signatureCacheIdentity } from '../scripts/windows-signature-cache.mjs'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(import.meta.dirname, 'cache-test-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'module.node')
  await writeFile(path, 'original')
  const cache = join(root, 'cache')
  const state = { hardwareCalls: 0, events: [] as object[] }
  const thumbprint = 'A'.repeat(40)
  const options: import('../scripts/windows-signature-cache.mjs').WindowsSignatureCacheOptions = {
    root: cache, identity: 'test-policy', thumbprint,
    sign: async ({ path }) => { state.hardwareCalls++; await writeFile(path, `signed:${await readFile(path, 'utf8')}`) },
    inspect: async path => ({ status: (await readFile(path, 'utf8')).startsWith('signed:') ? 'Valid' : 'NotSigned', timestamped: true, thumbprint }),
    record: event => state.events.push(event),
  }
  const request = { path, hash: 'sha256', isNest: false }
  return { root, path, cache, state, options, request }
}

test('unchanged bytes restored in another file avoid another hardware call', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  const second = join(f.root, 'other.node')
  await writeFile(second, 'original')
  await createCachedSigner(f.options)({ ...f.request, path: second })
  assert.equal(f.state.hardwareCalls, 1)
  assert.equal(await readFile(second, 'utf8'), 'signed:original')
  assert.equal(f.state.events.filter(e => 'type' in e && e.type === 'signature-cache-hit').length, 1)
})

test('restores cached signatures into deeply nested dependency paths', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  const directory = join(f.root, 'dependency'.repeat(12))
  await mkdir(directory)
  const path = join(directory, 'module.node')
  await writeFile(path, 'original')
  await createCachedSigner(f.options)({ ...f.request, path })
  assert.equal(await readFile(path, 'utf8'), 'signed:original')
  assert.equal(f.state.hardwareCalls, 1)
  assert.deepEqual(await readdir(directory), ['module.node'])
})

test('different content or signing policy misses the cache', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  await writeFile(f.path, 'changed')
  await createCachedSigner(f.options)(f.request)
  await writeFile(f.path, 'original')
  await createCachedSigner({ ...f.options, identity: 'changed-policy' })(f.request)
  assert.equal(f.state.hardwareCalls, 3)
})

for (const corrupt of ['payload', 'record.json']) test(`corrupt ${corrupt} stops without signing or replacing the input`, async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  await writeFile(f.path, 'original')
  const entry = (await readdir(f.cache)).find(name => !name.startsWith('.'))
  assert(entry)
  await writeFile(join(f.cache, entry, corrupt), 'corrupt')
  await assert.rejects(createCachedSigner(f.options)(f.request))
  assert.equal(f.state.hardwareCalls, 1)
  assert.equal(await readFile(f.path, 'utf8'), 'original')
})

for (const signature of [
  { status: 'NotTrusted', timestamped: true, thumbprint: 'A'.repeat(40) },
  { status: 'Valid', timestamped: false, thumbprint: 'A'.repeat(40) },
  { status: 'Valid', timestamped: true, thumbprint: 'B'.repeat(40) },
]) test(`cache refuses signature ${JSON.stringify(signature)}`, async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  await writeFile(f.path, 'original')
  await assert.rejects(createCachedSigner({ ...f.options, inspect: async () => signature })(f.request), /invalid cached signature/u)
  assert.equal(f.state.hardwareCalls, 1)
  assert.equal(await readFile(f.path, 'utf8'), 'original')
})

test('hardware failure rejects queued work without publishing an entry or retrying', async (t) => {
  const f = await fixture(t)
  const signer = createCachedSigner({ ...f.options, sign: async () => { f.state.hardwareCalls++; throw new Error('hardware failed') } })
  const results = await Promise.allSettled([signer(f.request), signer(f.request)])
  assert(results.every(result => result.status === 'rejected'))
  assert.equal(f.state.hardwareCalls, 1)
  assert.deepEqual(await readdir(f.cache), [])
})

test('a failed new signature verification never publishes a cache entry', async (t) => {
  const f = await fixture(t)
  await assert.rejects(createCachedSigner({ ...f.options, inspect: async () => ({ status: 'NotTrusted', timestamped: false, thumbprint: null }) })(f.request), /new signature verification failed/u)
  assert.deepEqual(await readdir(f.cache), [])
})

test('an incomplete entry is rejected without hardware access', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  const entry = (await readdir(f.cache))[0]
  assert(entry)
  await rm(join(f.cache, entry, 'record.json'))
  await writeFile(f.path, 'original')
  await assert.rejects(createCachedSigner(f.options)(f.request))
  assert.equal(f.state.hardwareCalls, 1)
})

test('certificate and toolchain content invalidate policy identity independently of paths', async (t) => {
  const f = await fixture(t)
  const certificate = join(f.root, 'certificate.cer')
  const command = join(f.root, 'sign.cmd')
  await writeFile(certificate, 'certificate A')
  await writeFile(command, 'signing policy A')
  const first = await signatureCacheIdentity([certificate, command])
  const relocated = join(f.root, 'relocated.cer')
  await writeFile(relocated, 'certificate A')
  assert.equal(await signatureCacheIdentity([relocated, command]), first)
  await writeFile(certificate, 'certificate B')
  assert.notEqual(await signatureCacheIdentity([certificate, command]), first)
  await writeFile(command, 'signing policy B')
  assert.notEqual(await signatureCacheIdentity([relocated, command]), first)
})

test('two writers publish one complete entry without overwriting another writer', async (t) => {
  const f = await fixture(t)
  const second = join(f.root, 'second.node')
  await writeFile(second, 'original')
  const entered = Promise.withResolvers<undefined>()
  let arrivals = 0
  const options: import('../scripts/windows-signature-cache.mjs').WindowsSignatureCacheOptions = { ...f.options, sign: async (request) => {
    if (++arrivals === 2) entered.resolve(undefined)
    await entered.promise
    await f.options.sign(request)
  } }
  const results = await Promise.allSettled([
    createCachedSigner(options)(f.request),
    createCachedSigner(options)({ ...f.request, path: second }),
  ])
  for (const result of results) if (result.status === 'rejected') throw result.reason
  assert.equal((await readdir(f.cache)).length, 1)
  await writeFile(f.path, 'original')
  await createCachedSigner(f.options)(f.request)
  assert.equal(f.state.hardwareCalls, 2)
  assert.equal(await readFile(f.path, 'utf8'), 'signed:original')
})

test('linked cache directories cannot redirect cache restoration', async (t) => {
  const f = await fixture(t)
  const elsewhere = join(f.root, 'elsewhere')
  await mkdir(elsewhere)
  await symlink(elsewhere, f.cache, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createCachedSigner(f.options)(f.request), /unlinked directory/u)
  assert.equal(f.state.hardwareCalls, 0)
})

test('a target changed during verification is never replaced with stale cache bytes', async (t) => {
  const f = await fixture(t)
  await createCachedSigner(f.options)(f.request)
  await writeFile(f.path, 'original')
  const inspect = async (candidate: string) => { await writeFile(f.path, 'new input'); return f.options.inspect(candidate) }
  await assert.rejects(createCachedSigner({ ...f.options, inspect })(f.request), /target changed/u)
  assert.equal(await readFile(f.path, 'utf8'), 'new input')
  assert.equal(f.state.hardwareCalls, 1)
  assert(!(await readdir(f.root)).some(name => name.startsWith('.signature-restore-')))
})
