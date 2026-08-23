/** Parse and validate one recorded-session snapshot manifest. */

import { isAbsolute } from 'node:path'
import * as yaml from 'js-yaml'

/** Public `dsh` profile used to control a recorded-session scenario. */
export type SnapshotProfile = 'headless' | 'sdk' | 'acp' | 'web'

/** Optional reference to another scenario's canonical session. */
export interface SnapshotSessionReference {
  /** Repository-relative POSIX path from this scenario directory to the owning `session.jsonl`. */
  source: string
}

/** Declarative ownership metadata stored beside a recorded session. */
export interface SnapshotManifest {
  /** Manifest format version. */
  version: 1
  /** Shipped profile whose public interface controls the scenario. */
  profile: SnapshotProfile
  /** Absent when this directory owns `session.jsonl`; present for a read-only borrower. */
  session?: SnapshotSessionReference
}

const PROFILES = new Set<SnapshotProfile>(['headless', 'sdk', 'acp', 'web'])

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key)).sort()
  if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`)
}

/**
 * Parse one `snapshot.yml` without admitting JavaScript YAML tags or unknown fields.
 * @param source - complete manifest text.
 * @param path - diagnostic path.
 * @returns validated manifest metadata.
 */
export function parseSnapshotManifest(source: string, path = 'snapshot.yml'): SnapshotManifest {
  let parsed: unknown
  try {
    parsed = yaml.load(source, { schema: yaml.JSON_SCHEMA })
  } catch (error) {
    throw new Error(`session-snapshot: ${path}: invalid YAML: ${String(error)}`)
  }

  try {
    const root = record(parsed, 'manifest')
    exactKeys(root, ['version', 'profile', 'session'], 'manifest')
    if (root.version !== 1) throw new Error('manifest.version must equal 1')
    if (typeof root.profile !== 'string' || !PROFILES.has(root.profile as SnapshotProfile)) {
      throw new Error('manifest.profile must be headless, sdk, acp, or web')
    }

    let session: SnapshotSessionReference | undefined
    if (root.session !== undefined) {
      const value = record(root.session, 'manifest.session')
      exactKeys(value, ['source'], 'manifest.session')
      if (typeof value.source !== 'string' || value.source.trim() === '') {
        throw new Error('manifest.session.source must be a non-empty string')
      }
      if (isAbsolute(value.source) || value.source.includes('\\') || value.source.includes('\0')) {
        throw new Error('manifest.session.source must be a relative POSIX path')
      }
      session = { source: value.source }
    }

    return {
      version: 1,
      profile: root.profile as SnapshotProfile,
      ...(session === undefined ? {} : { session }),
    }
  } catch (error) {
    throw new Error(`session-snapshot: ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
