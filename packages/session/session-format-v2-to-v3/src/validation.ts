/** V3 event admission and released lifecycle validation for PTC dispatches. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
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
 * Validate v3 event admission, relationships, and inherited cut without changing the artifact.
 * @param artifact - detached v3 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact.
 */
export function restoreReleasedV3Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV3Header(artifact.header)
  restoreReleasedV2Artifact({
    ...artifact,
    header: { ...artifact.header, version: 2 },
    events: artifact.events.map(releasedValidationEvent),
  }, knownEventTypes, 3)
  return artifact
}

/**
 * Refuse required predecessor PTC tags in a native v3 event.
 * @param event - decoded event whose physical envelope was validated.
 */
export function assertV3EventAdmission(event: SessionFormatEvent): void {
  if ((event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch')
    && event['ignorable'] !== true) {
    throw new SessionFormatUnsupportedMigrationError(
      'format v3 contains unknown event type ' + JSON.stringify(event.type) + ' at seq ' + String(event.seq),
    )
  }
}

/** Adapt only the validator input; released codecs and returned events keep their own names. */
function releasedValidationEvent(event: SessionFormatEvent): SessionFormatEvent {
  switch (event.type) {
    case 'tool/ptc-dispatch-start':
      return { ...event, type: 'tool/code-dispatch-start' }
    case 'tool/ptc-dispatch':
      return { ...event, type: 'tool/code-dispatch' }
    case 'tool/code-dispatch-start':
    case 'tool/code-dispatch':
      assertV3EventAdmission(event)
      // An obsolete ignorable event is opaque, not a released-v2 lifecycle contribution.
      return { ...event, type: 'v3/opaque-released-event' }
    default:
      return event
  }
}
