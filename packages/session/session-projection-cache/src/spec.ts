/**
 * The projection-cache record schema: one `projection_cache.json` per
 * session, stored under the cache's own root tree at
 * `<root>/<session-id>/projection_cache.json` (independent of session
 * persistence). The file holds the session's full projection checkpoint
 * (`key → {ver, seq, val}` rows) plus the log identity it was folded from.
 * @module @deepseek-ai/dsh-session-projection-cache/src/spec
 */

import { z } from 'zod'

/**
 * One persisted checkpoint row (the RFC's `(sessionId, key, ver, seq, val)`
 * minus the two record keys). `val` is the unit's internal state — plain
 * JSON by the unit contract; `z.json()` enforces that at the durable
 * boundary. A row is never wrong, only possibly stale: `seq` says exactly
 * how stale, and a `ver` mismatch against the live unit's `stateVersion`
 * discards it at read time (never a migration).
 */
export const checkpointRow = z.object({
  ver: z.number().int().nonnegative(),
  seq: z.number().int().gte(-1),
  val: z.json(),
})

/**
 * The stored-log identity a record is bound to: the immutable header fields
 * that distinguish one session lifecycle from another under the same id. A
 * session id names a slot, not a lifecycle — a deleted-then-recreated id, or
 * a persistence root swapped under a surviving cache, would otherwise let an
 * old record pass every watermark check and seed state folded from an
 * unrelated log. Reads validate this against the live header (listing) or
 * the stored header (cold read) before accepting any record.
 */
export const checkpointIdentity = z.object({
  createdAt: z.number().int().nonnegative(),
  cwd: z.string().optional(),
})

/** The identity fields a record is bound to, inferred from {@link checkpointIdentity}. */
export type CheckpointIdentity = z.infer<typeof checkpointIdentity>

/**
 * One session's stored record: the log identity it was folded from plus its
 * checkpoint rows keyed by projection key. The whole record is replaced on
 * every write (whole-value discipline — the registry checkpoint is always
 * the complete per-session cut).
 */
export const checkpointRecord = z.object({
  identity: checkpointIdentity,
  rows: z.record(z.string(), checkpointRow),
})

/** One stored per-session checkpoint record, inferred from {@link checkpointRecord}. */
export type CheckpointRecord = z.infer<typeof checkpointRecord>
