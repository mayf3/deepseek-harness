/** Browser Client bridge construction for the Cordis plugin entry. */

import type { InspectorClientBootstrap } from '../../shared/bridge/messages/control.ts'
import { ClientInspectorSource } from './transport.ts'

/**
 * Start the browser source transport for one validated Host bootstrap.
 * @param bootstrap - Host-injected endpoint and resource limits.
 * @returns The active reconnecting Client source.
 */
export function startInspectorClient(bootstrap: InspectorClientBootstrap): ClientInspectorSource {
  return new ClientInspectorSource(bootstrap)
}
