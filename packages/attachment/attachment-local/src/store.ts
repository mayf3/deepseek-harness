/** Content-addressed, owner-private local attachment storage. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, parse, resolve } from 'node:path'
import {
  AttachmentError,
  AttachmentId,
} from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { detectImage, probeImage } from './image.ts'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const durableHomes = new Set<string>()
/* Witness for a directory entry this store created but never proved durable:
   the home of a save whose required proof failed (or that crashed after the
   witnesses became durable, before completing the parent syncs), or any
   level of a created subtree. Without it, the residue would be
   indistinguishable from a deployed home and the next save would demote the
   same parent syncs to best-effort. The whole created subtree is built
   privately under the boundary, every level's witness is synced before one
   atomic rename publishes the highest missing entry, so no concurrent save
   and no crash that leaves created entries behind can observe them without
   a witness. */
const UNPROVEN_HOME_MARKER = '.unproven-home'

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Strip both separator styles by hand: a POSIX host treats `\` as an
  // ordinary character, so path.basename would keep a Windows client's full
  // local path and leak it into the reference and the session log.
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

function objectPath(root: string, sha256: string): string {
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

function ensureReference(ref: ImageAttachmentRef): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]
}

async function inspectMetadata(
  data: Uint8Array,
  declaredMediaType: ImageAttachmentRef['mediaType'],
  limits: ImageAttachmentLimits,
): Promise<Omit<ImageAttachmentRef, 'attachmentId' | 'name'>> {
  if (data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  const detected = await detectImage(data, { maxPixels: limits.maxImagePixels, maxDimension: limits.maxImageDimension })
  if (detected.mediaType !== declaredMediaType) throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
  return { ...detected, bytes: data.byteLength }
}

/**
 * Run the full admission policy for one image without touching storage.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved storage policy.
 * @returns completion after the encoded raster has been fully decoded.
 */
export async function validateImageFile(input: SaveImageAttachment, limits: ImageAttachmentLimits): Promise<void> {
  if (input.data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  await inspectMetadata(input.data, input.mediaType, limits)
}

/**
 * Make a directory's entries durable (fsync on a read-only directory handle).
 * A synced file alone does not survive a crash when its directory entry never
 * reached storage, so the publication directory is synced before a durable
 * reference is reported.
 */
async function syncDirectory(path: string): Promise<void> {
  /* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  /* v8 ignore stop */
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
}

function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isEntryConflict(error: unknown): boolean {
  /* Windows reports an occupied rename target as EPERM rather than ENOTEMPTY. */
  /* v8 ignore next -- win32-only branch; the Linux coverage lane never exercises it. */
  if (process.platform === 'win32') return error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY' || error.code === 'EPERM')
  return error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
}

/** Whether one directory carries an unproven-entry witness. */
async function hasWitness(level: string): Promise<boolean> {
  try {
    await stat(join(level, UNPROVEN_HOME_MARKER))
    return true
  } catch (error: unknown) {
    /* v8 ignore next 2 -- The boundary walk traversed every scanned level and
       the store owns created modes, so only ENOENT is reachable. */
    if (!isENOENT(error)) throw error
    return false
  }
}

/* Discard the private staging tree after a failure or a lost publish race.
   Only this call's own staged entries are touched: deployed entries, a
   concurrent winner's published chain, and any file content anywhere are
   never removed. A leftover here is private litter under a fresh UUID name —
   it can never become a later save's boundary — so the discard is
   best-effort and the save's own failure remains the loud outcome. */
async function discardCreatedStaging(levels: string[]): Promise<void> {
  for (const level of [...levels].reverse()) {
    await unlink(join(level, UNPROVEN_HOME_MARKER)).catch(
      /* v8 ignore next -- The witness may not exist yet when the witness write itself failed. */
      () => {},
    )
    await rmdir(level).catch(
      /* v8 ignore next -- Only reachable if the private staging tree was externally modified, which no deterministic test schedules. */
      () => {},
    )
  }
}

/**
 * Create one private directory tree and persist every ancestor entry up to a
 * caller-vouched durable boundary. The walk deliberately ignores what mkdir
 * reports as newly created: a concurrent first save can create a level this
 * process then merely observes, so "already existed" is not "already durable"
 * — the entry may still be unsynced in the creator, and a crash would drop a
 * directory the session checkpoint already references. Re-syncing a durable
 * entry is harmless; skipping an unsynced one is not. Callers pass boundaries
 * this process owns or has already proven, so every sync here covers an entry
 * this call may have created and a failure — permission or otherwise — fails
 * the save loudly instead of reporting a reference it cannot prove.
 * @param path - absolute directory to create.
 * @param boundary - absolute ancestor the caller vouches is already durable.
 */
async function ensureDurableDirectory(path: string, boundary: string): Promise<void> {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    /* v8 ignore next -- filesystem-root guard: callers pass a boundary that is an ancestor of path, so the walk reaches it first. */
    if (parent === level) return
    level = parent
  }
}

/**
 * Establish this process's proof that one DSH_HOME entry is durable, bounded
 * as high as those proofs reach. Every entry this call may create — the home
 * itself and any missing ancestor below the first existing one — is synced
 * required: its recording parent must fsync or the save fails, because the
 * walk can only reach what the credentials permit and POSIX grants write and
 * search on a directory whose entries cannot be read. Above that created
 * range the call changes nothing, so it syncs further ancestors best-effort:
 * each one another account owns bounds the guarantee there (their deploy-time
 * entries are outside this process's proof), and stopping is sound precisely
 * because no entry of this call lives at or above the stop. Mere existence is
 * still insufficient within the proven range: a concurrent process may have
 * created a directory but not synced its parent, so the walk re-syncs every
 * level it can open.
 *
 * The publish unit for a missing home is the whole subtree from the highest
 * missing entry down to the home. It is built inside one private staging
 * directory under the boundary, every created level's witness (an unproven
 * marker) is synced there, and one atomic rename publishes the highest
 * missing entry — so no concurrent save or crash can observe a created
 * entry without a witness. A save that observes witnesses re-runs the
 * required proof over the whole ancestor chain instead of treating the
 * residue as a deployed home, and clears the witnesses it proved.
 * @param path - absolute DSH_HOME to prove durable.
 * @returns the resolved home path.
 */
async function ensureDurableHome(path: string): Promise<string> {
  const home = resolve(path)
  if (!durableHomes.has(home)) {
    /* Highest already-existing ancestor: mkdir adds entries only below it. */
    let created = false
    let boundary = home
    for (;;) {
      try {
        await stat(boundary)
        break
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
      }
      created = true
      const parent = dirname(boundary)
      /* v8 ignore next 3 -- only reachable when the whole home path sits
         directly below the filesystem root, which no test fs can arrange. */
      if (parent === boundary) {
        boundary = parse(home).root
        break
      }
      boundary = parent
    }
    const stop = parse(home).root
    if (created) {
      /* Publish unit: the whole subtree from the highest missing entry down
         to the home is built inside one private staging directory under the
         boundary. Every created level receives its witness and a directory
         sync before one atomic rename publishes the highest missing entry —
         nothing this call creates is ever observable without a durable
         witness, and every failure discards only this private tree.

         A lost publish race re-scans the chain: if the home itself now
         exists the winner published it and is observed; if the winner
         published only an ancestor — a different home sharing the missing
         chain — this home still does not exist, so the protocol re-enters
         one level deeper under the winner's witnessed chain instead of
         mistaking the ancestor for a proven home. The boundary strictly
         descends with every lost race, bounding the loop by the path
         depth. */
      while (created) {
        let highestMissing = home
        while (dirname(highestMissing) !== boundary) highestMissing = dirname(highestMissing)
        const staged = join(boundary, `.${basename(home)}.${randomUUID()}.unproven`)
        const mRels: string[] = []
        for (let level = home; level !== highestMissing; level = dirname(level)) mRels.unshift(level.slice(highestMissing.length + 1))
        const levels = [staged, ...mRels.map(rel => join(staged, rel))]
        let published = false
        try {
          await mkdir(staged, { recursive: true, mode: 0o700 })
          await chmod(staged, 0o700)
          for (const rel of mRels) await mkdir(join(staged, rel), { recursive: true, mode: 0o700 })
          for (const level of levels) {
            await writeFile(join(level, UNPROVEN_HOME_MARKER), '', { mode: 0o600 })
            /* The witness becomes durable before the entry becomes observable. */
            await syncDirectory(level)
          }
          try {
            await rename(staged, highestMissing)
            published = true
          } catch (error: unknown) {
            if (!isEntryConflict(error)) {
              /* v8 ignore next -- A fresh staging tree can only race a concurrent winner
                 (EEXIST/ENOTEMPTY/Windows EPERM); the injected-failure test covers this throw. */
              throw error
            }
            /* Re-scan from the home upward: the first existing ancestor is
               the winner's published chain. If that chain reaches the home,
               the winner published this home — observe it; otherwise the
               boundary descends into the winner's ancestor and the protocol
               re-enters with this home still to create. */
            let scan = home
            for (;;) {
              try {
                await stat(scan)
                break
              } catch (scanError: unknown) {
                /* v8 ignore next -- The boundary walk proved search on every scanned level, so only ENOENT is reachable. */
                if (!isENOENT(scanError)) throw scanError
              }
              const parent = dirname(scan)
              /* v8 ignore next 3 -- only reachable when the whole home path sits
                 directly below the filesystem root, which no test fs can arrange. */
              if (parent === scan) {
                scan = parse(home).root
                break
              }
              scan = parent
            }
            if (scan === home) created = false
            else boundary = scan
          }
        } finally {
          if (!published) await discardCreatedStaging(levels)
        }
        if (published) break
      }
    }
    /* Existing entries carrying a witness: the home itself when this call
       did not create it — including a concurrent winner's home after a lost
       rename — and every ancestor up to the filesystem root. A rollback
       marks whichever created entry it could not remove, and that entry can
       sit above the boundary a later save observes, so the scan cannot be
       bounded by the boundary. Every scanned level was already traversed by
       the walk (stat(home) proves search on the whole chain), so a witness
       can never hide. */
    const marked: string[] = []
    if (!created && await hasWitness(home)) marked.push(home)
    for (let level = dirname(home); level !== stop; level = dirname(level)) {
      if (await hasWitness(level)) marked.push(level)
      /* v8 ignore next -- filesystem-root guard: dirname reaches the root before level stops shrinking. */
      if (level === dirname(level)) break
    }
    /* Required range: the parent recording each directory this call created,
       and — above any witness this call found — the whole ancestor chain. A
       permission failure in a required range is a real durability hole —
       POSIX allows write+search without read, so the entry may exist
       unproveably — and fails the save instead of reporting an unproven
       reference. */
    let residueProven = false
    if (marked.length > 0) {
      /* A witness means some entry on this chain was created without a
         completed proof: re-prove the whole ancestor chain — no best-effort
         stop — and clear every witness only once that proof completes. */
      for (let level = dirname(home); level !== stop; level = dirname(level)) {
        await syncDirectory(level)
        /* v8 ignore next -- filesystem-root guard: dirname reaches the root before level stops shrinking. */
        if (level === dirname(level)) break
      }
      for (const level of marked) {
        await unlink(join(level, UNPROVEN_HOME_MARKER))
        await syncDirectory(level)
      }
      residueProven = true
    }
    if (!residueProven && created) {
      /* Required range: the parent recording each directory this call
         created. A permission failure here is a real durability hole — POSIX
         allows write+search without read, so the entry may exist unproveably
         — and fails the save instead of reporting an unproven reference. */
      for (let level = dirname(home); ; level = dirname(level)) {
        await syncDirectory(level)
        /* v8 ignore next -- The walk stops at the boundary by construction; falling through would loop forever. */
        if (level === boundary) break
      }
    }
    /* Best-effort range above this call's writes: stop at the first ancestor
       this process cannot open. */
    if (!residueProven) {
      for (let level = dirname(created ? boundary : home); level !== stop; level = dirname(level)) {
        try {
          await syncDirectory(level)
        } catch (error: unknown) {
          if (isPermissionError(error)) break
          throw error
        }
        /* v8 ignore next -- filesystem-root guard: dirname reaches the root before level stops shrinking. */
        if (level === dirname(level)) break
      }
    }
    if (created) {
      /* The proof completed: unmark. The home sync makes the marker's
         removal itself durable, so a crash cannot resurrect a stale marker
         on an already-proven home. */
      await unlink(join(home, UNPROVEN_HOME_MARKER))
      await syncDirectory(home)
    }
    durableHomes.add(home)
  }
  return home
}

/**
 * Save and verify immutable image bytes below a versioned attachment root.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved storage policy.
 * @returns durable content-addressed reference.
 */
export async function saveImageFile(root: string, input: SaveImageAttachment, limits: ImageAttachmentLimits): Promise<ImageAttachmentRef> {
  if (input.data.byteLength > limits.maxImageBytes) throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  const metadata = await inspectMetadata(input.data, input.mediaType, limits)
  const sha256 = digest(input.data)
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const staging = join(root, 'tmp')
  // Establish DSH_HOME itself against the filesystem root once per process.
  // Every process performs that proof independently, so observing a directory
  // another process created can never be mistaken for durable publication.
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  await ensureDurableDirectory(bucket, boundary)
  await ensureDurableDirectory(staging, boundary)
  const temporary = join(staging, randomUUID())
  const target = objectPath(root, sha256)
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(input.data)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await link(temporary, target)
    } catch (error) {
      /* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const existing = new Uint8Array(await readFile(target))
      if (digest(existing) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
    }
    // Persist the target entry and close a concurrent bucket-creation window
    // before the reference can reach a session checkpoint. The dedup path
    // repeats both syncs because it may observe another writer's link before
    // that writer reaches its own durability boundary.
    await syncDirectory(bucket)
    await syncDirectory(join(root, 'objects'))
    await unlink(temporary)
  } catch (error) {
    /* v8 ignore next -- A descriptor can remain open only when the underlying write/sync/close operation fails. */
    if (handle !== undefined) await handle.close().catch(
      /* v8 ignore next -- Close failure is superseded by the storage operation that entered cleanup. */
      () => {},
    )
    await unlink(temporary).catch(
      /* v8 ignore next -- The callback requires a second independent staging-unlink failure. */
      (cleanupError: unknown) => {
        /* v8 ignore next -- Cleanup is best-effort only for a staging file already removed by a failed operation. */
        if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) throw cleanupError
      },
    )
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to persist image attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
  const name = displayName(input.name)
  return {
    attachmentId: AttachmentId(`sha256:${sha256}`),
    ...metadata,
    ...(name !== undefined ? { name } : {}),
  }
}

/**
 * Read and verify one content-addressed image.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @param signal - optional cancellation for filesystem and verification work.
 * @returns verified bytes and reference.
 * @throws the signal reason when aborted, or an AttachmentError when verification fails.
 */
export async function readImageFile(
  root: string,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredImageAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(objectPath(root, sha256), { signal }))
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
  signal?.throwIfAborted()
  if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  // The digest proves these are the exact bytes admission fully decoded, so
  // the read path only re-derives the header fields (no raster decode, no
  // per-request pixel amplification on history replay).
  const metadata = await probeImage(data)
  signal?.throwIfAborted()
  if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
    || metadata.width !== ref.width || metadata.height !== ref.height) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}
