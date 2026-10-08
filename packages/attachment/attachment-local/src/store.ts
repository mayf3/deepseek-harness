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
   witness became durable, before completing the parent syncs), or an entry a
   failed rollback could not remove. Without it, the residue would be
   indistinguishable from a deployed home and the next save would demote the
   same parent syncs to best-effort. The witness is staged inside the home's
   directory and made durable before an atomic rename publishes the home, so
   no concurrent save and no crash that leaves the home behind can observe it
   without the witness. */
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
  return error instanceof Error && 'code' in error
    && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
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

/** Drop a witness into an entry the rollback could not remove. */
async function markUnremovable(level: string): Promise<void> {
  /* Best-effort: if the witness cannot be written either, the save's own
     loud failure remains the only outcome.
     v8 ignore next -- Requires the same condition that broke the rollback to
     also break the witness write, which no deterministic test schedules. */
  await writeFile(join(level, UNPROVEN_HOME_MARKER), '', { mode: 0o600 }).catch(
    /* v8 ignore next -- See above; the save has already failed loudly. */
    () => {},
  )
}

/* Remove the staged home and every entry this call created below the
   boundary, so no residue can shrink a later save's required boundary past
   an unproven entry. rmdir is non-recursive: an entry a concurrent creator
   occupies survives with its content untouched and is itself marked, so a
   later save re-runs the required proof over it. Ownership is not checked —
   an empty entry a concurrent creator just made can be removed, and that
   creator's own recursive mkdir recreates it. The original failure the
   caller rethrows remains the loud outcome. */
async function rollBackCreatedChain(staged: string, home: string, boundary: string): Promise<void> {
  const chain = [staged]
  /* Entries strictly below the boundary — the boundary itself predates this
     call and is never removed; the root stops the walk in the degenerate
     boundary-is-nothing case. */
  const stop = parse(home).root
  for (let level = dirname(home); level !== boundary && level !== stop; level = dirname(level)) {
    chain.push(level)
  }
  for (const level of chain) {
    try {
      await rmdir(level)
    } catch (error: unknown) {
      /* v8 ignore next 3 -- ENOENT requires a concurrent remover racing this
         rollback, which no deterministic test schedules. */
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        await markUnremovable(level)
      }
    }
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
 * A home this call creates is published by an atomic rename from a staged
 * directory whose durable witness (an unproven marker) is already inside, so
 * no concurrent save or crash can observe an unmarked created home. A home
 * this call could not prove keeps that witness, as does any created entry a
 * rollback could not remove, and the next save that observes a witness
 * re-runs the required proof over the whole ancestor chain instead of
 * treating the residue as a deployed home.
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
    let staged: string | undefined
    if (created) {
      /* Stage the witness inside a private sibling and rename it into place:
         the home's first observable state already carries its witness, so no
         concurrent save and no crash can observe an unmarked created home
         and mistake it for a deployed one. */
      staged = join(dirname(home), `.${basename(home)}.${randomUUID()}.unproven`)
      await mkdir(staged, { recursive: true, mode: 0o700 })
      await chmod(staged, 0o700)
      try {
        await writeFile(join(staged, UNPROVEN_HOME_MARKER), '', { mode: 0o600 })
      } catch (error: unknown) {
        await rollBackCreatedChain(staged, home, boundary)
        throw error
      }
      /* The witness becomes durable before the home becomes observable. */
      await syncDirectory(staged)
      try {
        await rename(staged, home)
      } catch (error: unknown) {
        /* v8 ignore next 3 -- A fresh staged directory can only race a
           concurrent winner (EEXIST/ENOTEMPTY); other rename failures are
           exotic filesystem errors no test fs schedules. */
        if (!isEntryConflict(error)) {
          await rollBackCreatedChain(staged, home, boundary)
          throw error
        }
        /* A concurrent first save won the rename and its home already
           carries the witness: observe it instead of creating. */
        await unlink(join(staged, UNPROVEN_HOME_MARKER)).catch(
          /* v8 ignore next -- Superseded by the storage failure that entered cleanup. */
          () => {},
        )
        await rollBackCreatedChain(staged, home, boundary)
        created = false
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
    } else if (created) {
      for (let level = dirname(home); ; level = dirname(level)) {
        await syncDirectory(level)
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
