import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import {
  isReadableSessionPersistenceListing,
  type SessionPersistenceListing,
} from '../src/index.ts'

const header = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('listing'),
  createdAt: 1,
  isSeeded: false,
} as const

describe('isReadableSessionPersistenceListing', () => {
  it.each<SessionPersistenceListing>([
    { status: 'current', header, storedVersion: 1, targetVersion: 1 },
    { status: 'migration-required', header, storedVersion: 0, targetVersion: 1 },
  ])('accepts $status descriptors carrying current logical headers', (listing) => {
    expect(isReadableSessionPersistenceListing(listing)).toBe(true)
  })

  it.each<SessionPersistenceListing>([
    {
      status: 'unsupported',
      storedVersion: 2,
      targetVersion: 1,
      location: { kind: 'test', path: '/unsupported/session.jsonl' },
      reason: 'future format',
    },
    {
      status: 'malformed',
      targetVersion: 1,
      location: { kind: 'test', path: '/malformed/session.jsonl' },
      reason: 'bad header',
    },
  ])('rejects $status descriptors without logical headers', (listing) => {
    expect(isReadableSessionPersistenceListing(listing)).toBe(false)
  })
})
