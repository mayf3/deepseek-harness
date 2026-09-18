/** Cache complete signed files; corrupt entries stop the caller before hardware access. */
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, toNamespacedPath } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * Include public certificate and every file that controls signing output in the policy identity.
 * @param {readonly string[]} files Certificate, SignTool, signing script and signer implementation paths, in fixed order.
 * @returns {Promise<string>} Content identity independent of installation paths and PIN values.
 */
export async function signatureCacheIdentity(files) {
  return digest(JSON.stringify(await Promise.all(files.map(async path => digest(await regularFile(path))))))
}

async function regularFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`signature cache: expected regular file: ${path}`)
  return readFile(path)
}

async function directory(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error(`signature cache: expected unlinked directory: ${path}`)
  }
}

function validSignature(signature, thumbprint) {
  return signature.status === 'Valid' && signature.timestamped
    && signature.thumbprint?.toUpperCase() === thumbprint.toUpperCase()
}

/**
 * Wrap a supervised signer with immutable entries keyed by unsigned bytes and signing policy.
 * @param {import('./windows-signature-cache.mjs').WindowsSignatureCacheOptions} options Cache policy and existing supervised operations.
 * @returns {ReturnType<typeof import('./windows-sign.mjs').createWindowsTokenSigner>} Serial, fail-stop signing callback; cache hits still verify trust and timestamp.
 */
export function createCachedSigner(options) {
  let pending = Promise.resolve()
  async function readEntry(entry, key, inputDigest) {
    await directory(entry)
    const record = JSON.parse((await regularFile(join(entry, 'record.json'))).toString('utf8'))
    if (record === null || typeof record !== 'object' || record.version !== 1 || record.key !== key || record.inputDigest !== inputDigest
      || record.identity !== options.identity || typeof record.signedDigest !== 'string'
      || !/^[a-f\d]{64}$/u.test(record.signedDigest)) throw new Error('signature cache: invalid input record')
    const payload = await regularFile(join(entry, 'payload'))
    if (digest(payload) !== record.signedDigest) throw new Error('signature cache: corrupt signed payload')
    return record
  }
  async function sign(configuration) {
    if (configuration.hash !== 'sha256' || configuration.isNest) throw new Error('signature cache: only unsigned SHA-256 runtime files are supported')
    const inputDigest = digest(await regularFile(configuration.path))
    const key = digest(JSON.stringify({ version: 1, inputDigest, identity: options.identity }))
    await mkdir(options.root, { recursive: true })
    await directory(options.root)
    const entry = join(options.root, key)
    let hit = false
    try { await lstat(entry); hit = true }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (hit) {
      const record = await readEntry(entry, key, inputDigest)
      const staging = await mkdtemp(toNamespacedPath(join(dirname(configuration.path), '.signature-restore-')))
      try {
        const candidate = join(staging, basename(configuration.path))
        await copyFile(join(entry, 'payload'), candidate)
        if (digest(await regularFile(candidate)) !== record.signedDigest) throw new Error('signature cache: restore changed signed bytes')
        if (!validSignature(await options.inspect(candidate), options.thumbprint)) throw new Error('signature cache: invalid cached signature')
        if (digest(await regularFile(configuration.path)) !== inputDigest) throw new Error('signature cache: target changed before restore')
        await rename(candidate, configuration.path)
      } finally { await rm(staging, { recursive: true, force: true }) }
      options.record({ type: 'signature-cache-hit', key, path: configuration.path })
      return
    }
    options.record({ type: 'signature-cache-miss', key, path: configuration.path })
    await options.sign(configuration)
    if (!validSignature(await options.inspect(configuration.path), options.thumbprint)) throw new Error('signature cache: new signature verification failed')
    const staging = await mkdtemp(toNamespacedPath(join(options.root, '.publish-')))
    try {
      await copyFile(configuration.path, join(staging, 'payload'))
      const signedDigest = digest(await regularFile(join(staging, 'payload')))
      if (signedDigest !== digest(await regularFile(configuration.path))) throw new Error('signature cache: signed file changed during publication')
      await writeFile(join(staging, 'record.json'), JSON.stringify({ version: 1, key, inputDigest, identity: options.identity, signedDigest }), { flag: 'wx', flush: true })
      try { await rename(staging, entry) }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
        await readEntry(entry, key, inputDigest)
      }
      options.record({ type: 'signature-cache-published', key, path: configuration.path })
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  return configuration => {
    pending = pending.then(() => sign(configuration))
    return pending
  }
}
