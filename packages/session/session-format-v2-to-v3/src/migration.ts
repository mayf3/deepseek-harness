/** Identity adjacent stage; events and compact runs retain their values and ordering. */

import { SessionFormatError, defineSessionFormatMigration, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV2Header } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header } from './validation.ts'

/** Adjacent identity migration from released v2 to v3; refuses source delivery markers claiming v3 acceptance. */
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
      && isSessionFormatJsonObject(event.data)) {
      if (event.data['sessionFormatVersion'] === 3) {
        throw new SessionFormatError('format v2 delivery marker claims target format v3')
      }
      if (event.data['sessionFormatVersion'] === 2
        && event.data['sessionId'] !== this.input.sourceHeader.id) {
        this.lastForeignDeliverySeq = event.seq
      }
    }
    context.emitEvent(event)
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
