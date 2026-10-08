import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { readImageFile, saveImageFile } from '../src/store.ts'

const fsControl = vi.hoisted(() => ({
  readSignals: [] as AbortSignal[],
  syncedDirectories: [] as string[],
  failOpenFor: undefined as string | undefined,
  failWriteFileFor: undefined as string | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile(...args: Parameters<typeof actual.readFile>): ReturnType<typeof actual.readFile> {
      const options = args[1]
      if (typeof options === 'object' && options !== null) {
        const signal = (options as { signal?: AbortSignal }).signal
        if (signal !== undefined) fsControl.readSignals.push(signal)
      }
      return actual.readFile(...args)
    },
    async writeFile(...args: Parameters<typeof actual.writeFile>): ReturnType<typeof actual.writeFile> {
      if (fsControl.failWriteFileFor !== undefined && String(args[0]) === fsControl.failWriteFileFor) {
        throw Object.assign(new Error('injected marker write failure'), { code: 'EACCES' })
      }
      return actual.writeFile(...args)
    },
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      if (fsControl.failOpenFor !== undefined && args[1] === constants.O_RDONLY && String(args[0]) === fsControl.failOpenFor) {
        throw Object.assign(new Error('injected ancestor sync failure'), { code: 'ENOENT' })
      }
      const handle = await actual.open(...args)
      if (args[1] === constants.O_RDONLY) fsControl.syncedDirectories.push(String(args[0]))
      return handle
    },
  }
})

const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

const LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 2048,
  maxImagePixels: 16,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
  roots.push(value)
  return join(value, 'attachments', 'v1')
}

function parentChainToRoot(path: string): string[] {
  const parents: string[] = []
  let level = resolve(path)
  const root = parse(level).root
  while (level !== root) {
    level = dirname(level)
    /* The filesystem root itself is excluded: it holds no entry of this call,
       so the bounded walk never syncs it. */
    if (level !== root) parents.push(level)
  }
  return parents
}

afterEach(async () => {
  fsControl.failOpenFor = undefined
  fsControl.failWriteFileFor = undefined
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('local attachment store', () => {
  it.skipIf(process.platform === 'win32')('syncs every object ancestor up to the durable boundary before returning', async () => {
    const storageRoot = await root()
    const base = join(storageRoot, '..', '..')
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const objects = join(storageRoot, 'objects')
    const bucket = join(objects, sha256.slice(0, 2))
    fsControl.syncedDirectories.length = 0

    await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)

    // Each process first proves DSH_HOME durable all the way to the filesystem
    // root; existence alone cannot vouch for a concurrent creator's fsync.
    // Later directory creation can then stop at that process-proven boundary.
    expect(fsControl.syncedDirectories).toEqual([
      ...parentChainToRoot(base),
      // bucket chain: every parent entry between the bucket and the boundary.
      objects,
      storageRoot,
      join(storageRoot, '..'),
      base,
      // staging chain re-walks the shared ancestors after creating tmp.
      storageRoot,
      join(storageRoot, '..'),
      base,
      // publication: the settled object's bucket and its parent for the rename.
      bucket,
      objects,
    ])
  })

  it('creates and persists a missing nested home directory against the filesystem root', async () => {
    const storageRoot = join(await root(), 'home', 'attachments', 'v1')

    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)

    await expect(readImageFile(storageRoot, ref)).resolves.toEqual({ ref, data: PNG })
  })

  it.skipIf(process.platform === 'win32')('bounds the durability proof above an unopenable ancestor that holds no entry of this call', async () => {
    const top = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    roots.push(top)
    const home = join(top, 'home')
    const storageRoot = join(home, 'attachments', 'v1')
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const objects = join(storageRoot, 'objects')
    const bucket = join(objects, sha256.slice(0, 2))
    await mkdir(home, { recursive: true })
    // The home pre-exists, so this save creates nothing at or above it; the
    // ancestor is made traverse-only for the owner (the production shape where
    // homes sit below another account's root) and the proof honestly stops
    // there instead of claiming ancestors it cannot open.
    await chmod(top, 0o0111)
    fsControl.syncedDirectories.length = 0
    try {
      const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)

      await expect(readImageFile(storageRoot, ref)).resolves.toEqual({ ref, data: PNG })
      // The unopenable ancestor stays unsynced; the proof covers the home and
      // every directory the save creates below it, whose publication chain is
      // fully synced.
      expect(fsControl.syncedDirectories).toEqual([
        objects,
        storageRoot,
        join(storageRoot, '..'),
        home,
        storageRoot,
        join(storageRoot, '..'),
        home,
        bucket,
        objects,
      ])
    } finally {
      await chmod(top, 0o0700)
    }
  })

  it.skipIf(process.platform === 'win32')('proceeds when a writable-unreadable ancestor holds no entry of this call', async () => {
    const top = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    roots.push(top)
    const home = join(top, 'home')
    const storageRoot = join(home, 'attachments', 'v1')
    await mkdir(home, { recursive: true })
    // Write+search without read (0o300): the process could create entries
    // here, but this save creates none — the home predates the call — so the
    // bounded stop is sound and the save proceeds.
    await chmod(top, 0o0300)
    try {
      const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)

      await expect(readImageFile(storageRoot, ref)).resolves.toEqual({ ref, data: PNG })
    } finally {
      await chmod(top, 0o0700)
    }
  })

  it.skipIf(process.platform === 'win32')('fails loudly when it creates a home entry it cannot prove durable', async () => {
    const top = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    roots.push(top)
    const home = join(top, 'home')
    const storageRoot = join(home, 'attachments', 'v1')
    // The home is missing, so the call creates its entry in a write+search
    // (0o300) parent whose entries cannot be read or fsynced: the required
    // proof of that new entry fails and the save must refuse, not report an
    // unprovable reference.
    await chmod(top, 0o0300)
    try {
      await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS))
        .rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(top, 0o0700)
    }
  })

  it.skipIf(process.platform === 'win32')('keeps refusing when a retry saves into the home a failed proof left behind', async () => {
    const top = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    roots.push(top)
    const home = join(top, 'home')
    const storageRoot = join(home, 'attachments', 'v1')
    await chmod(top, 0o0300)
    try {
      // The first save creates the home, fails its required proof loudly, and
      // leaves the home entry behind in the write+search-only parent.
      await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS))
        .rejects.toMatchObject({ code: 'EACCES' })
      // An ordinary retry observes the residue as an existing home and must
      // not demote the same parent sync to best-effort: the entry is still
      // unproven, so the retry keeps refusing instead of returning a
      // reference whose home durability was never established.
      await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS))
        .rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(top, 0o0700)
    }
  })

  it.skipIf(process.platform === 'win32')('refuses a home marked unproven until its proof can complete, then clears the marker', async () => {
    const top = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    roots.push(top)
    const home = join(top, 'home')
    const storageRoot = join(home, 'attachments', 'v1')
    await mkdir(home, { recursive: true })
    // The residue shape another process (or a post-crash restart) observes:
    // the failed proof left the created home plus its unproven marker. The
    // bounded best-effort stop must not absorb the unopenable parent while
    // the marker stands.
    await writeFile(join(home, '.unproven-home'), '')
    await chmod(top, 0o0300)
    try {
      await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS))
        .rejects.toMatchObject({ code: 'EACCES' })

      // Once the parent becomes provable, the next save re-runs the required
      // proof, clears the marker, and proceeds without leaving residue.
      await chmod(top, 0o0700)
      const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)
      await expect(readImageFile(storageRoot, ref)).resolves.toEqual({ ref, data: PNG })
      await expect(stat(join(home, '.unproven-home'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await chmod(top, 0o0700)
    }
  })

  it.skipIf(process.platform === 'win32')('leaves no unproven marker behind a fully proven created home', async () => {
    const top = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    roots.push(top)
    const home = join(top, 'home')
    const storageRoot = join(home, 'attachments', 'v1')

    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)

    await expect(readImageFile(storageRoot, ref)).resolves.toEqual({ ref, data: PNG })
    await expect(stat(join(home, '.unproven-home'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('removes the created home when its unproven marker cannot be written', async () => {
    const top = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    roots.push(top)
    const home = join(top, 'home')
    const storageRoot = join(home, 'attachments', 'v1')
    fsControl.failWriteFileFor = join(home, '.unproven-home')
    try {
      // A residue home without its marker would be indistinguishable from a
      // deployed home, so the failed marker write removes the created home
      // and the save fails loudly.
      await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS))
        .rejects.toMatchObject({ code: 'EACCES' })
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })

      // The later save therefore re-enters the created path with its full
      // required proof instead of treating residue as deployed.
      fsControl.failWriteFileFor = undefined
      const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)
      await expect(readImageFile(storageRoot, ref)).resolves.toEqual({ ref, data: PNG })
    } finally {
      fsControl.failWriteFileFor = undefined
    }
  })

  it.skipIf(process.platform === 'win32')('syncs the parent recording each directory it creates', async () => {
    const top = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    roots.push(top)
    const home = join(top, 'home')
    const storageRoot = join(home, 'attachments', 'v1')
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const objects = join(storageRoot, 'objects')
    const bucket = join(objects, sha256.slice(0, 2))
    fsControl.syncedDirectories.length = 0

    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)

    await expect(readImageFile(storageRoot, ref)).resolves.toEqual({ ref, data: PNG })
    // The created home's recording entry is synced first (required), the
    // best-effort vouching continues above it, the unproven marker's removal
    // is made durable with a home sync, and the created bucket/staging chains
    // are each synced up to the home boundary.
    expect(fsControl.syncedDirectories).toEqual([
      top,
      ...parentChainToRoot(top),
      home,
      objects,
      storageRoot,
      join(storageRoot, '..'),
      home,
      storageRoot,
      join(storageRoot, '..'),
      home,
      bucket,
      objects,
    ])
  })

  it('fails loudly when the storage root path is not a directory', async () => {
    const top = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    roots.push(top)
    const storageRoot = join(top, 'home', 'attachments', 'v1')
    await mkdir(join(top, 'home'), { recursive: true })
    await writeFile(join(top, 'home', 'attachments'), Uint8Array.of(0))

    await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS))
      .rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('propagates scan errors other than a missing path', async () => {
    const top = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    roots.push(top)
    await writeFile(join(top, 'blocker'), Uint8Array.of(0))
    const storageRoot = join(top, 'blocker', 'home', 'attachments', 'v1')

    // The home sits below a regular file, so the existence scan itself fails
    // with ENOTDIR — neither a missing path nor a permission boundary — and
    // the save refuses instead of proving anything.
    await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS))
      .rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it.skipIf(process.platform === 'win32')('propagates ancestor sync failures that are not permission denials', async () => {
    const storageRoot = await root()
    fsControl.failOpenFor = dirname(join(storageRoot, '..', '..'))

    await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes one private content-addressed object and deduplicates equal bytes', async () => {
    const storageRoot = await root()
    const first = await saveImageFile(storageRoot, {
      data: PNG, mediaType: 'image/png', name: '/private/tmp/pixel.png',
    }, LIMITS)
    const second = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const object = join(storageRoot, 'objects', sha256.slice(0, 2), sha256)

    expect(first).toEqual({
      attachmentId: `sha256:${sha256}`,
      mediaType: 'image/png',
      bytes: PNG.byteLength,
      width: 1,
      height: 1,
      name: 'pixel.png',
    })
    expect(second.attachmentId).toBe(first.attachmentId)
    expect(new Uint8Array(await readFile(object))).toEqual(PNG)
    if (process.platform !== 'win32') {
      expect((await stat(object)).mode & 0o777).toBe(0o600)
      expect((await stat(join(storageRoot, 'objects', sha256.slice(0, 2)))).mode & 0o777).toBe(0o700)
    }
    await expect(readImageFile(storageRoot, first)).resolves.toEqual({ ref: first, data: PNG })
  })

  it('keeps admitted history readable after deployment limits become stricter', async () => {
    const storageRoot = await root()
    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)

    await expect(readImageFile(storageRoot, ref)).resolves.toEqual({ ref, data: PNG })
  })

  it('forwards read cancellation to the filesystem and preserves its reason', async () => {
    const storageRoot = await root()
    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)
    const controller = new AbortController()
    fsControl.readSignals.length = 0

    await expect(readImageFile(storageRoot, ref, controller.signal)).resolves.toEqual({ ref, data: PNG })
    expect(fsControl.readSignals).toEqual([controller.signal])

    const cancellation = new Error('attachment read cancelled')
    controller.abort(cancellation)
    await expect(readImageFile(storageRoot, ref, controller.signal)).rejects.toBe(cancellation)
  })

  it('rejects malformed bytes, mismatched declarations, byte limits, and decoded-pixel limits', async () => {
    const storageRoot = await root()
    await expect(saveImageFile(storageRoot, {
      data: new Uint8Array(0), mediaType: 'image/png',
    }, LIMITS)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(saveImageFile(storageRoot, {
      data: Uint8Array.of(1, 2, 3), mediaType: 'image/png',
    }, LIMITS)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(saveImageFile(storageRoot, {
      data: PNG, mediaType: 'image/jpeg',
    }, LIMITS)).rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' })
    await expect(saveImageFile(storageRoot, {
      data: PNG, mediaType: 'image/png',
    }, { ...LIMITS, maxImageBytes: 1 })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })

    const wide = new Uint8Array(await sharp({
      create: { width: 5, height: 5, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer())
    await expect(saveImageFile(storageRoot, {
      data: wide, mediaType: 'image/png',
    }, LIMITS)).rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
    await expect(saveImageFile(storageRoot, {
      data: wide, mediaType: 'image/png',
    }, { ...LIMITS, maxImagePixels: 25, maxImageDimension: 4 })).rejects.toMatchObject({ code: 'IMAGE_DIMENSION_TOO_LARGE' })
    const unnamed = await saveImageFile(storageRoot, {
      data: PNG, mediaType: 'image/png', name: '\u0000',
    }, LIMITS)
    expect(unnamed).not.toHaveProperty('name')
  })

  it('fails closed when an object is missing, corrupted, or addressed by an invalid reference', async () => {
    const storageRoot = await root()
    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)
    const sha256 = String(ref.attachmentId).slice('sha256:'.length)
    const object = join(storageRoot, 'objects', sha256.slice(0, 2), sha256)
    await chmod(object, 0o600)
    await writeFile(object, Uint8Array.of(1, 2, 3))
    await expect(readImageFile(storageRoot, ref))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    await expect(readImageFile(storageRoot, { ...ref, attachmentId: 'bad' as never }))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })

    const missingRoot = await root()
    await mkdir(missingRoot, { recursive: true })
    await expect(readImageFile(missingRoot, ref))
      .rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })

    const unreadableRoot = await root()
    const target = join(unreadableRoot, 'objects', sha256.slice(0, 2), sha256)
    await mkdir(target, { recursive: true })
    await expect(readImageFile(unreadableRoot, ref))
      .rejects.toMatchObject({ code: 'ATTACHMENT_READ_FAILED' })
  })

  it('rejects conflicting existing objects and reference metadata mismatches', async () => {
    const storageRoot = await root()
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const target = join(storageRoot, 'objects', sha256.slice(0, 2), sha256)
    await mkdir(join(storageRoot, 'objects', sha256.slice(0, 2)), { recursive: true })
    await writeFile(target, Uint8Array.of(1, 2, 3))
    await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })

    await writeFile(target, PNG)
    const ref = await saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS)
    await expect(readImageFile(storageRoot, { ...ref, width: ref.width + 1 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('maps unexpected publication failures to a stable storage error', async () => {
    const storageRoot = await root()
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const target = join(storageRoot, 'objects', sha256.slice(0, 2), sha256)
    await mkdir(target, { recursive: true })

    await expect(saveImageFile(storageRoot, { data: PNG, mediaType: 'image/png' }, LIMITS))
      .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
  })
})
