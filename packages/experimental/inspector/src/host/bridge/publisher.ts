/** Buffered Host observation publication over a dedicated Worker MessagePort. */

import type { MessagePort } from 'node:worker_threads'
import { InspectorSourceBuffer, type InspectorSourceBufferOptions } from '../../shared/bridge/buffer.ts'
import type { InspectorJsonValue } from '../../shared/json.ts'
import type { InspectorStatePublisher } from '../../shared/bridge/publisher.ts'
import type { InspectorSourceDescriptor } from '../../shared/bridge/messages/observation.ts'

/** Non-blocking Host publisher with microtask-coalesced MessagePort writes. */
export class HostBridgePublisher implements InspectorStatePublisher {
  private readonly records: InspectorSourceBuffer
  private flushScheduled = false
  private closed = false

  constructor(
    private readonly port: MessagePort,
    private readonly source: InspectorSourceDescriptor,
    options: InspectorSourceBufferOptions,
  ) {
    this.records = new InspectorSourceBuffer(options)
  }

  publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()): void {
    if (this.closed) return
    this.records.publish(topic, payload, monotonicMs)
    this.scheduleFlush()
  }

  setState(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()): void {
    if (this.closed) throw new Error('inspector: Host source is closed')
    this.records.setState(topic, payload, monotonicMs)
    this.scheduleFlush()
  }

  /** Send the retained state as a complete source replacement. */
  replace(): void {
    this.port.postMessage(this.records.replacement(this.source.sourceId, this.source.generation))
  }

  /** Flush every currently queued observation batch. */
  flush(): void {
    let frame = this.records.takeBatch(this.source.sourceId, this.source.generation)
    while (frame !== undefined) {
      this.port.postMessage(frame)
      frame = this.records.takeBatch(this.source.sourceId, this.source.generation)
    }
  }

  /** Flush pending observations and reject later publication. */
  close(): void {
    if (this.closed) return
    this.flush()
    this.closed = true
  }

  private scheduleFlush(): void {
    if (!this.records.hasPending || this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      this.flush()
    })
  }
}
