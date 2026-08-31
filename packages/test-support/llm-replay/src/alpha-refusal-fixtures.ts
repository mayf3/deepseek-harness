/** Exact repository fixtures allowed to bypass migration only for test replay and comparison. */

import { resolve } from 'node:path'

/** One committed alpha fixture whose real catalog refusal remains required. */
export interface AlphaSessionFormatRefusalFixture {
  /** Repository-relative source identity used by corpus diagnostics. */
  readonly repoRelativePath: string
  /** Exact absolute source path accepted by replay-only helpers. */
  readonly path: string
  /** Exact source-qualified migration diagnostic the corpus must retain. */
  readonly expectedMessage: string
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..')

/** Closed replay-only exception inventory; production persistence never imports it. */
export const ALPHA_SESSION_FORMAT_REFUSAL_FIXTURES: readonly AlphaSessionFormatRefusalFixture[] = Object.freeze([
  Object.freeze({
    repoRelativePath: 'snapshots/session/agent-instructions/session.jsonl',
    path: resolve(REPOSITORY_ROOT, 'snapshots/session/agent-instructions/session.jsonl'),
    expectedMessage: 'session snapshot line 22: @deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: compaction checkpoint at seq 20 has no matching compaction/start',
  }),
  Object.freeze({
    repoRelativePath: 'snapshots/web/schedule-catalog/session.jsonl',
    path: resolve(REPOSITORY_ROOT, 'snapshots/web/schedule-catalog/session.jsonl'),
    expectedMessage: 'session snapshot line 4: @deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: session/title 2 messageSeqs must be empty exactly for a user title',
  }),
])

const BY_PATH: ReadonlyMap<string, AlphaSessionFormatRefusalFixture> = new Map(
  ALPHA_SESSION_FORMAT_REFUSAL_FIXTURES.map(fixture => [fixture.path, fixture]),
)

/**
 * Resolve one exact replay-only exception without admitting copied lookalikes.
 * @param sourcePath - caller-supplied fixture source path.
 * @returns the matching closed-manifest entry, or `undefined`.
 */
export function alphaSessionFormatRefusalForPath(
  sourcePath: string,
): AlphaSessionFormatRefusalFixture | undefined {
  return BY_PATH.get(resolve(sourcePath))
}
