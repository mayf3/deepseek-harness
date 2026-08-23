/** Parse and validate one recorded-session snapshot manifest. */

import { isAbsolute } from 'node:path'
import * as yaml from 'js-yaml'

/** Public `dsh` profile used to control a recorded-session scenario. */
export type SnapshotProfile = 'headless' | 'sdk' | 'acp' | 'web'

/** How a canonical session may be regenerated. */
export type SnapshotRecording = 'live' | 'authored'

/** Request-header ownership metadata for one composition. */
export interface SnapshotHeaderManifest {
  /** Stable class name shared only by byte-identical request headers. */
  class: string
  /** Whether this scenario owns the class's tokenized header sequence. */
  pin?: true
  /** Scenario that owns the readable system-prompt sidecar. */
  systemPromptSource?: string
  /** Scenario that owns the readable tool-schema sidecar. */
  toolSchemasSource?: string
  /** Child fixture indexes that own distinct system-prompt sidecars. */
  childSystemPrompts?: number[]
  /** Child fixture indexes that own distinct tool-schema sidecars. */
  childToolSchemas?: number[]
  /** Legitimate changed-header count after the initial request header. */
  changes?: number
}

/** Replay facts that cannot be reconstructed from successful model chunks. */
export interface SnapshotReplayManifest {
  /** A scenario-local `replay.override.json` replaces or patches the recorded model script. */
  override: true
}

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
  /** Composition id whose sole pin owns its profile patches. */
  composition?: string
  /** Whether the session is live-recordable or deliberately authored. */
  recording?: SnapshotRecording
  /** Request-header class and sidecar ownership. */
  header?: SnapshotHeaderManifest
  /** Exceptional replay metadata absent for ordinary successful recordings. */
  replay?: SnapshotReplayManifest
  /** Absent when this directory owns `session.jsonl`; present for a read-only borrower. */
  session?: SnapshotSessionReference
}

const PROFILES = new Set<SnapshotProfile>(['headless', 'sdk', 'acp', 'web'])
const RECORDINGS = new Set<SnapshotRecording>(['live', 'authored'])
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

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

function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || !NAME_RE.test(value)) {
    throw new Error(`${label} must be a lower-kebab-case name`)
  }
  return value
}

function positiveIndexes(value: unknown, label: string): number[] {
  if (!Array.isArray(value)
    || value.some(item => !Number.isInteger(item) || Number(item) < 1)
    || new Set(value).size !== value.length) {
    throw new Error(`${label} must be an array of unique positive integers`)
  }
  return [...value as number[]]
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
    exactKeys(root, ['version', 'profile', 'composition', 'recording', 'header', 'replay', 'session'], 'manifest')
    if (root.version !== 1) throw new Error('manifest.version must equal 1')
    if (typeof root.profile !== 'string' || !PROFILES.has(root.profile as SnapshotProfile)) {
      throw new Error('manifest.profile must be headless, sdk, acp, or web')
    }

    const composition = root.composition === undefined
      ? undefined
      : name(root.composition, 'manifest.composition')
    let recording: SnapshotRecording | undefined
    if (root.recording !== undefined) {
      if (typeof root.recording !== 'string' || !RECORDINGS.has(root.recording as SnapshotRecording)) {
        throw new Error('manifest.recording must be live or authored')
      }
      recording = root.recording as SnapshotRecording
    }

    let header: SnapshotHeaderManifest | undefined
    if (root.header !== undefined) {
      const value = record(root.header, 'manifest.header')
      exactKeys(value, [
        'class',
        'pin',
        'systemPromptSource',
        'toolSchemasSource',
        'childSystemPrompts',
        'childToolSchemas',
        'changes',
      ], 'manifest.header')
      if (value.pin !== undefined && value.pin !== true) {
        throw new Error('manifest.header.pin must equal true when present')
      }
      if (value.changes !== undefined && (!Number.isInteger(value.changes) || Number(value.changes) < 0)) {
        throw new Error('manifest.header.changes must be a non-negative integer')
      }
      header = {
        class: name(value.class, 'manifest.header.class'),
        ...(value.pin === true ? { pin: true as const } : {}),
        ...(value.systemPromptSource === undefined
          ? {}
          : { systemPromptSource: name(value.systemPromptSource, 'manifest.header.systemPromptSource') }),
        ...(value.toolSchemasSource === undefined
          ? {}
          : { toolSchemasSource: name(value.toolSchemasSource, 'manifest.header.toolSchemasSource') }),
        ...(value.childSystemPrompts === undefined
          ? {}
          : { childSystemPrompts: positiveIndexes(value.childSystemPrompts, 'manifest.header.childSystemPrompts') }),
        ...(value.childToolSchemas === undefined
          ? {}
          : { childToolSchemas: positiveIndexes(value.childToolSchemas, 'manifest.header.childToolSchemas') }),
        ...(value.changes === undefined ? {} : { changes: Number(value.changes) }),
      }
    }

    let replay: SnapshotReplayManifest | undefined
    if (root.replay !== undefined) {
      const value = record(root.replay, 'manifest.replay')
      exactKeys(value, ['override'], 'manifest.replay')
      if (value.override !== true) throw new Error('manifest.replay.override must equal true')
      replay = { override: true }
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
      ...(composition === undefined ? {} : { composition }),
      ...(recording === undefined ? {} : { recording }),
      ...(header === undefined ? {} : { header }),
      ...(replay === undefined ? {} : { replay }),
      ...(session === undefined ? {} : { session }),
    }
  } catch (error) {
    throw new Error(`session-snapshot: ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
