/** Source-side interfaces shared by MessagePort and WebSocket bridge implementations. */

import type { InspectorJsonValue } from '../json.ts'
import type { InspectorQueryRequester } from './messages/query/commands.ts'

/** Transport-independent observation publisher. */
export interface InspectorPublisher {
  /** Publish one validated observation. */
  publish(topic: string, payload: InspectorJsonValue, monotonicMs?: number): void
}

/** Publisher that also retains the latest value of stateful observation topics. */
export interface InspectorStatePublisher extends InspectorPublisher {
  /**
   * Replace one topic's retained state and publish the replacement.
   * @param topic - Domain-owned state topic.
   * @param payload - Latest JSON state, replayed after source resynchronization.
   * @param monotonicMs - Source-clock timestamp; defaults to `performance.now()`.
   */
  setState(topic: string, payload: InspectorJsonValue, monotonicMs?: number): void
}

/** Shared capabilities exposed above a Host MessagePort or Client WebSocket carrier. */
export interface InspectorConnection extends InspectorStatePublisher, InspectorQueryRequester {}
