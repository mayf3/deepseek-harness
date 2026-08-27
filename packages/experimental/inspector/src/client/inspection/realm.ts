/** Stable Client source identity with a fresh descriptor for each WebSocket generation. */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { inspectorId } from '../../shared/identity.ts'
import type { InspectorSourceDescriptor } from '../../shared/bridge/messages/observation.ts'
import { bridgeCapabilities } from '../cdp/index.ts'

/** Owns one browser realm's stable source id across transport reconnects. */
export class ClientRealmSource {
  /** Logical source id retained across reconnecting transport generations. */
  readonly sourceId = inspectorId<'InspectorSourceId'>(`client-${randomUUID()}`, 'sourceId')

  constructor(private readonly label: string) {}

  /**
   * Create the descriptor for one newly admitted transport generation.
   * @param hasSources - Whether the built Client bundle is available for source reads.
   * @returns A source descriptor with a fresh generation.
   */
  connect(hasSources: boolean): InspectorSourceDescriptor {
    return {
      sourceId: this.sourceId,
      generation: inspectorId<'InspectorSourceGeneration'>(randomUUID(), 'generation'),
      kind: 'client',
      label: this.label,
      timeOriginMs: performance.timeOrigin,
      capabilities: bridgeCapabilities(clientOrigin(), hasSources),
    }
  }
}

function clientOrigin(): string {
  const location = Reflect.get(globalThis, 'location') as unknown
  if (typeof location !== 'object' || location === null) return ''
  const origin = Reflect.get(location, 'origin') as unknown
  return typeof origin === 'string' ? origin : ''
}
