/** V3 validation preserves the released-v2 event model. */

import { SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV2Header, restoreReleasedV2Artifact } from '@deepseek-ai/dsh-session-format-v1-to-v2'

/**
 * Validate v3 logical metadata with the released-v2 fields.
 * @param header - decoded v3 Session header.
 */
export function assertReleasedV3Header(header: SessionFormatHeader): void {
  if (header.version !== 3) throw new SessionFormatError('expected format v3 header')
  assertReleasedV2Header({ ...header, version: 2 })
}

/**
 * Validate v3 event admission, relationships, and inherited cut without copying events.
 * @param artifact - detached v3 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact.
 */
export function restoreReleasedV3Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV3Header(artifact.header)
  restoreReleasedV2Artifact({ ...artifact, header: { ...artifact.header, version: 2 } }, knownEventTypes, 3)
  return artifact
}
