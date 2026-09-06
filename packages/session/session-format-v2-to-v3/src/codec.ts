/** V3 record encoding shares the unchanged released-v2 physical event language. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatMigrationContext,
  SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, assertV3EventAdmission } from './validation.ts'

/** Physical v3 codec with current PTC event admission and released-v2 record encoding. */
export const releasedV3SessionFormatCodec = Object.freeze({
  version: 3,
  decodeHeader(value: unknown) {
    return { ...releasedV2SessionFormatCodec.decodeHeader(v2PhysicalHeader(value)), version: 3 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV2SessionFormatCodec.createDecoder(v2PhysicalHeader(value), recovery)
    return {
      ...decoder,
      header: { ...decoder.header, version: 3 },
      decodeRow(row: unknown, context: SessionFormatMigrationContext) {
        decoder.decodeRow(row, {
          emitEvent(event) {
            assertV3EventAdmission(event)
            context.emitEvent(event)
          },
          emitRun: context.emitRun.bind(context),
        })
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV3Header(header)
    return {
      ...releasedV2SessionFormatCodec.encodeHeader({ ...header, version: 2 }, inheritedEventCount),
      version: 3,
    }
  },
  encodeEvent: releasedV2SessionFormatCodec.encodeEvent,
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

function v2PhysicalHeader(value: unknown): SessionFormatHeader {
  const header = snapshotSessionFormatJson(value, 'format v3 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 3) {
    throw new SessionFormatError('expected format v3 physical Session header')
  }
  return { ...header, version: 2 } as SessionFormatHeader
}
