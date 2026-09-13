/**
 * Canonicalize coverage locations inside a coverage partition, before its
 * blob is written.
 *
 * Vitest remaps V8 coverage separately per Vite environment, so one source file
 * can carry two statement maps in a single run: a node suite maps it through the
 * ssr environment, a `@vitest-environment jsdom` suite maps it through the
 * client environment, and ast-v8-to-istanbul spells the same statement
 * differently in each map (a whole-line statement ends at column `Infinity` in
 * the ssr map, at a nested expression column in the client map).
 *
 * istanbul-lib-coverage reconciles such overlapping ranges while merging, but
 * only while a location carries numeric line and column values: `Infinity`
 * survives an in-process merge, not the JSON serialization of a partition blob,
 * which turns it into `null`. Without that reconciliation the merge keeps the
 * client-only spelling as an extra, unhit statement, so a file whose every
 * statement ran still fails the per-file 100% gate.
 *
 * Replacing the non-finite end column with {@link END_OF_LINE_COLUMN} keeps the
 * line-end meaning, survives serialization, and keys identically in every blob,
 * so the merged report attributes the coverage one process would have reported.
 *
 * @module
 */

/**
 * End column of a location that spans to the end of its start line, and the
 * finite stand-in for ast-v8-to-istanbul's unrepresentable `Infinity`.
 */
export const END_OF_LINE_COLUMN = Number.MAX_SAFE_INTEGER

/** Mutable structural view of the istanbul coverage map handed to reporters. */
type CoverageRecord = Record<string, unknown>

/** Whether a value is a non-null object usable as a mutable record. */
function isRecord(value: unknown): value is CoverageRecord {
  return typeof value === 'object' && value !== null
}

/** Rewrite one location's non-finite end column in place. */
function canonicalizeLocation(location: unknown): void {
  if (!isRecord(location)) return
  const end = location['end']
  if (!isRecord(end)) return
  const column = end['column']
  if (typeof column === 'number' && Number.isFinite(column)) return
  end['column'] = END_OF_LINE_COLUMN
}

/** Rewrite every location a statement, function, or branch entry carries. */
function canonicalizeEntry(entry: unknown): void {
  if (!isRecord(entry)) return
  // A statement is a location itself; a function carries `decl` plus `loc`, and
  // a branch carries `loc` plus one location per branch path.
  canonicalizeLocation(entry)
  canonicalizeLocation(entry['decl'])
  canonicalizeLocation(entry['loc'])
  const locations = entry['locations']
  if (Array.isArray(locations)) for (const location of locations) canonicalizeLocation(location)
}

/**
 * Replace every non-finite end column of an istanbul coverage map in place.
 * @param coverageMap - istanbul `CoverageMap` whose `data` holds per-file coverage;
 * any value without that structure is left untouched.
 */
export function canonicalizeEndOfLineColumns(coverageMap: unknown): void {
  if (!isRecord(coverageMap)) return
  const files = coverageMap['data']
  if (!isRecord(files)) return
  for (const file of Object.values(files)) {
    if (!isRecord(file)) continue
    // FileCoverage keeps its maps on `data` and mirrors them as getters.
    const coverage = isRecord(file['data']) ? file['data'] : file
    for (const name of ['statementMap', 'fnMap', 'branchMap']) {
      const entries = coverage[name]
      if (!isRecord(entries)) continue
      for (const entry of Object.values(entries)) canonicalizeEntry(entry)
    }
  }
}

/**
 * Vitest reporter that canonicalizes a partition's coverage map in
 * {@link CanonicalCoverageLocationsReporter.onCoverage}, the hook Vitest runs
 * before the blob reporter serializes that map.
 */
export default class CanonicalCoverageLocationsReporter {
  /**
   * Canonicalize the finished run's coverage locations.
   * @param coverageMap - coverage map Vitest hands to every reporter.
   */
  public onCoverage(coverageMap: unknown): void {
    canonicalizeEndOfLineColumns(coverageMap)
  }
}
