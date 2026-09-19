/**
 * Client face of the Typert protocol: every Host export, with `RemoteStream`
 * resolving to the handle a generated Client method returns. Generated
 * Host-for-Client contracts import `RemoteStreamHandle` from this entry for
 * their stream signatures, so Client code that names a stream as
 * `RemoteStream<Out, In>` from this entry and the generated method agree,
 * while the Host alias stays an `AsyncIterable<Out>`.
 * @module @deepseek-ai/dsh-typert-protocol/client
 */

/**
 * One open Remote stream as the Client holds it: the downlink items as an
 * `AsyncIterable`, plus the uplink and cancellation of the same logical
 * stream. A handle stands for one generation: when the carrier is lost,
 * iteration fails with the carrier error and the handle is finished.
 * @template Out - item type the Host method yields.
 * @template In - item type the Client may send; `never` when the method reads none.
 */
export interface RemoteStreamHandle<Out, In> extends AsyncIterable<Out> {
  /**
   * Send one uplink item. Items sent before the stream has opened are queued
   * and sent once the `open` frame is on the wire.
   * @param item - item the Host validates against the method's uplink codec.
   * @throws {Error} when `end()` was called or the stream has terminated.
   */
  send(item: In): void
  /** Half-close the uplink: the Host's `uplink()` iteration ends. Idempotent; ignored after termination. */
  end(): void
  /**
   * Cancel the logical stream: send `cancel` unless a terminal frame has
   * arrived, and end the downlink iterator quietly. Breaking out of
   * `for await` early does the same.
   */
  dispose(): void
}

/**
 * `RemoteStream<Out, In>` on the Client face: the handle a generated Remote
 * method returns.
 * @template Out - item type the Host method yields.
 * @template In - item type the Client may send; `never` when the method reads none.
 */
export type RemoteStream<Out, In = never> = RemoteStreamHandle<Out, In>

export * from '../index.ts'
