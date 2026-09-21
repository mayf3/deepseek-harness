/**
 * Suggest the next build version for a product version, so the sequence number
 * is derived rather than remembered.
 *
 * The convention is `<product version>.<date>.<sequence>`. What makes a
 * sequence number correct is which ones are already taken, and that is recorded
 * where the builds went: the update bucket for a build that was uploaded, and
 * the local artifacts directory for one that was only handed over. Asking the
 * bucket first is what keeps a test feed's numbering unique across machines;
 * a fresh CI checkout has no local artifacts at all, which is why the local
 * scan only ever serves as a fallback.
 *
 * The bucket query is bounded and its failures are not fatal: a build must not
 * block on a listing, so an unreachable or unauthorized bucket degrades to the
 * local scan rather than failing the run. Concurrent builds can therefore pick
 * the same number, which matters for a release and not for a test feed — a
 * release publishes the product version itself and never comes through here,
 * and a production upload is expected to pass its version explicitly.
 */

import { readdir } from 'node:fs/promises'
import { parse } from 'semver'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { resolveDesktopUploadConfig } from './desktop-auto-update-environment.mjs'
import { createDesktopCos, DESKTOP_COS_REGION } from './desktop-cos.ts'
import { validateDesktopBuildVersion } from './desktop-build-version.mjs'
import type { DesktopPackageTargetName } from './package-target.ts'

/** How long a bucket listing may take before the suggestion falls back to local artifacts. */
const LISTING_TIMEOUT_MS = 8_000

/** Inputs that decide which versions are already taken. */
export interface DesktopBuildVersionSuggestionOptions {
  readonly productVersion: string
  readonly target: DesktopPackageTargetName
  readonly environment: NodeJS.ProcessEnv
  /** Date segment to number within; defaults to today where the build runs. */
  readonly date?: string
  readonly artifactsRoot?: string
}

/**
 * Format a date as the convention's segment.
 * @param date - Date to format.
 * @returns The date as `YYYYMMDD` in the build host's own time zone.
 */
export function desktopBuildDateSegment(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${String(date.getFullYear())}${month}${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Read the sequence numbers already used for one product version and date.
 * @param versions - Versions found in a bucket or directory.
 * @param prefix - `<product version>.<date>.` that a numbered build starts with.
 * @returns Every sequence number present, unordered.
 */
function sequenceNumbers(versions: Iterable<string>, prefix: string): number[] {
  const numbers: number[] = []
  for (const version of versions) {
    if (!version.startsWith(prefix)) continue
    const sequence = version.slice(prefix.length)
    if (/^\d+$/u.test(sequence)) numbers.push(Number(sequence))
  }
  return numbers
}

/**
 * Read the versions one artifacts directory already holds.
 * @param artifactsRoot - Directory electron-builder wrote installers into.
 * @returns Versions parsed from artifact names.
 */
async function localVersions(artifactsRoot: string): Promise<string[]> {
  const entries = await readdir(artifactsRoot).catch(() => [])
  const versions: string[] = []
  for (const entry of entries) {
    const named = /^deepseek-harness-(?<version>.+)-(?:mac|win)-(?:arm64|x64)\.(?:exe|dmg|zip)$/u.exec(entry)
    const version = named?.groups?.version
    if (version !== undefined && parse(version) !== null) versions.push(version)
  }
  return versions
}

/**
 * Read the versions one update bucket already publishes for a target.
 * @param options - Product version, target, and environment naming the bucket.
 * @returns Versions parsed from object names, or undefined when the bucket cannot be listed in time.
 */
async function remoteVersions(options: DesktopBuildVersionSuggestionOptions): Promise<string[] | undefined> {
  let update
  try {
    const target = options.target === 'win-x64' ? { platform: 'win32' as const, arch: 'x64' } : { platform: 'darwin' as const, arch: options.target === 'mac-arm64' ? 'arm64' : 'x64' }
    update = resolveDesktopUploadConfig(options.environment, target.platform, target.arch)
  }
  catch {
    // Without a configured destination there is nothing to be unique against.
    return undefined
  }
  const secretId = options.environment[update.secretIdEnvName]?.trim()
  const secretKey = options.environment[update.secretKeyEnvName]?.trim()
  if (secretId === undefined || secretId === '' || secretKey === undefined || secretKey === '') return undefined
  const cos = createDesktopCos({ secretId, secretKey })
  const listing = new Promise<string[]>((resolveListing, rejectListing) => {
    cos.getBucket({
      Bucket: update.bucket,
      Region: DESKTOP_COS_REGION,
      Prefix: `${update.binaryKeyPrefix}/deepseek-harness-`,
      MaxKeys: 1000,
    }, (error, data) => {
      if (error !== null && error !== undefined) rejectListing(error instanceof Error ? error : new Error(String(error)))
      else resolveListing((data?.Contents ?? []).map(object => object.Key))
    })
  })
  const timeout = new Promise<undefined>((resolveTimeout) => { setTimeout(() => resolveTimeout(undefined), LISTING_TIMEOUT_MS).unref() })
  const keys = await Promise.race([listing, timeout]).catch(() => undefined)
  if (keys === undefined) return undefined
  const versions: string[] = []
  for (const key of keys) {
    const named = /deepseek-harness-(?<version>.+)-(?:mac|win)-(?:arm64|x64)\.(?:exe|dmg|zip)$/u.exec(key)
    const version = named?.groups?.version
    if (version !== undefined && parse(version) !== null) versions.push(version)
  }
  return versions
}

/**
 * Suggest the next build version for today, numbering after what is already taken.
 * @param options - Product version, target, and environment to search.
 * @returns A validated build version whose sequence number is free.
 */
export async function suggestDesktopBuildVersion(options: DesktopBuildVersionSuggestionOptions): Promise<string> {
  const date = options.date ?? desktopBuildDateSegment()
  const prefix = `${options.productVersion}.${date}.`
  const remote = await remoteVersions(options)
  const taken = remote ?? await localVersions(options.artifactsRoot ?? desktopTargetBuildPaths(options.target).artifacts)
  const used = sequenceNumbers(taken, prefix)
  const next = used.length === 0 ? 1 : Math.max(...used) + 1
  const suggestion = validateDesktopBuildVersion(`${prefix}${String(next)}`, options.productVersion)
  process.stdout.write(`desktop package: numbering ${suggestion} after ${String(used.length)} ${
    remote === undefined ? 'local artifact' : 'published build'}${used.length === 1 ? '' : 's'} for ${prefix}*\n`)
  return suggestion
}
