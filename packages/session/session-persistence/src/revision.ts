/** Opaque revision identity for lightweight persistence observations. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Backend-owned token that identifies both one storage source and one revision
 * of a persisted session log.
 */
export type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>

/**
 * Brand a backend revision for the provider-neutral persistence contract.
 * @param value - backend-owned opaque revision representation.
 * @returns the same runtime string with persistence-revision identity.
 */
export function SessionPersistenceRevision(value: string): SessionPersistenceRevision {
  return value as SessionPersistenceRevision
}

/** A repeatable source can no longer reproduce the revision it represents. */
export class SessionPersistenceRevisionConflictError extends Error {
  /** @param message - source identity and expected revision context. */
  constructor(message: string) {
    super(message)
    this.name = 'SessionPersistenceRevisionConflictError'
  }
}
