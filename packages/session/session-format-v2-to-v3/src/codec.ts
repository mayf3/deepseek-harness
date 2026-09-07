/** V3 physical envelopes retain V2 provenance encoding and validate native system/header payloads. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatEvent,
  SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, assertV3EventAdmission } from './validation.ts'
import { assertEvent, assertV3StructuralRow } from './payload.ts'

/** Physical V3 codec with protected system-message payload admission and retired header.system refusal. */
export const releasedV3SessionFormatCodec = Object.freeze({
  version: 3,
  decodeHeader(value: unknown) {
    return { ...releasedV2SessionFormatCodec.decodeHeader(v2PhysicalHeader(value)), version: 3 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV2SessionFormatCodec.createDecoder(v2PhysicalHeader(value), recovery)
    return {
      ...decoder, header: { ...decoder.header, version: 3 },
      decodeRow(row, context) {
        assertV3RowAdmission(row)

        decoder.decodeRow(row, {
          emitEvent(event) {
            if (event.type === 'system/message' || event.type === 'request/header') assertEvent(event, 3)
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
  encodeEvent(event) {
    assertV3EventAdmission(event)
    if (event.type === 'system/message' || event.type === 'request/header') assertEvent(event, 3)
    return releasedV2SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Validate owned V3 admission rules before a scanner or codec can discard a recoverable tail.
 * This checks only identified structural payloads; physical provenance still belongs to decoding.
 * @param row - parsed physical row, before envelope or compressed-range decoding.
 */
export function assertV3RowAdmission(row: unknown): void {
  assertV3StructuralRow(row)
  if (typeof row === 'object' && row !== null && !Array.isArray(row)) assertV3EventAdmission(row as SessionFormatEvent)
}

function v2PhysicalHeader(value: unknown): SessionFormatHeader {
  const header = snapshotSessionFormatJson(value, 'format v3 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 3) {
    throw new SessionFormatError('expected format v3 physical Session header')
  }
  return { ...header, version: 2 } as SessionFormatHeader
}
