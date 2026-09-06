/** Adjacent PTC event and plugin-attribution migration with stable historical identities. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, defineSessionFormatMigration, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatJsonValue,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV2Header } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header } from './validation.ts'

/** Rename released-v2 PTC dispatch events and owned plugin attribution without changing ids or content. */
export const sessionFormatV2ToV3 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v2-to-v3',
  fromVersion: 2,
  toVersion: 3,
  migrateHeader(header) {
    assertReleasedV2Header(header)
    return { ...header, version: 3 }
  },
  createStage(input) {
    return new ReleasedV2ToV3Stage(input)
  },
  validateTargetHeader: assertReleasedV3Header,
})

class ReleasedV2ToV3Stage implements SessionFormatMigrationStage {
  private inheritedEventCount: number | undefined
  private lastForeignDeliverySeq: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    this.inheritedEventCount = input.sourceHeader.isSeeded ? undefined : 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.type === 'session/end-seed'
      && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) {
      this.inheritedEventCount = event.seq
    }
    if (event.type === 'session-log-deepseek/delivery-accepted'
      && isSessionFormatJsonObject(event.data)
      && event.data['sessionFormatVersion'] === 2
      && event.data['sessionId'] !== this.input.sourceHeader.id) {
      this.lastForeignDeliverySeq = event.seq
    }
    context.emitEvent(renamePtcEvent(event))
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    context.emitRun(run)
  }

  finish(_context: SessionFormatMigrationContext): number {
    const cut = sessionFormatCount(this.inheritedEventCount, 'format v2 inherited end-seed marker')
    if (this.input.sourceInheritedEventCount !== undefined && this.input.sourceInheritedEventCount !== cut) {
      throw new SessionFormatError('format v2 inherited end-seed marker disagrees with its source cut')
    }
    if (!this.input.sourceHeader.isSeeded && cut !== 0) {
      throw new SessionFormatError('format v2 unseeded Session contains an inherited end-seed marker')
    }
    if (this.lastForeignDeliverySeq !== undefined
      && (this.input.sourceHeader.parentSession === undefined || this.lastForeignDeliverySeq >= cut)) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    return cut
  }
}

function renamePtcEvent(event: SessionFormatEvent): SessionFormatEvent {
  switch (event.type) {
    case 'tool/ptc-dispatch-start':
    case 'tool/ptc-dispatch':
      throw new SessionFormatUnsupportedMigrationError(
        'format v2 event collides with reserved v3 type ' + JSON.stringify(event.type) + ' at seq ' + String(event.seq),
      )
    case 'tool/code-dispatch-start':
      return { ...event, type: 'tool/ptc-dispatch-start' }
    case 'tool/code-dispatch':
      return { ...event, type: 'tool/ptc-dispatch' }
    case 'user/message': {
      const data = renameMessageSource(event.data)
      return data === event.data ? event : { ...event, data }
    }
    case 'agent/inbox/spliced':
    case 'session/title-llm-request': {
      if (!isSessionFormatJsonObject(event.data)) return event
      const key = event.type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
      const messages = event.data[key]
      if (!Array.isArray(messages)) return event
      const renamed = messages.map(renameMessageSource)
      return renamed.every((message, index) => message === messages[index])
        ? event
        : { ...event, data: { ...event.data, [key]: renamed } }
    }
    default:
      // Other event payloads and merge-extensible content remain owner-opaque.
      return event
  }
}

function renameMessageSource(message: SessionFormatJsonValue): SessionFormatJsonValue {
  if (!isSessionFormatJsonObject(message)) return message
  const source = message['source']
  if (!isSessionFormatJsonObject(source)
    || source['kind'] !== 'plugin' || source['plugin'] !== 'tools-code-mode') return message
  return { ...message, source: { ...source, plugin: 'tools-ptc' } }
}
