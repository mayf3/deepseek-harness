/** Host adapter that publishes shared Cordis snapshots over the Host bridge. */

import type { Context } from '@deepseek-ai/cordis'
import type { CordisTreeLimits } from '../../shared/cordis/collector.ts'
import { observeCordisTree } from '../../shared/cordis/observer.ts'
import { CORDIS_TREE_TOPIC } from '../../shared/bridge/messages/cordis.ts'
import type { InspectorJsonValue } from '../../shared/json.ts'
import type { InspectorStatePublisher } from '../../shared/bridge/publisher.ts'

/**
 * Observe the Host Cordis runtime and retain its latest bridge snapshot.
 * @param ctx - Host plugin context whose root is inspected.
 * @param publisher - Active Host bridge publisher.
 * @param limits - Snapshot node and encoded-byte limits.
 * @returns A disposer that stops observation and releases retained objects.
 */
export function publishCordisTree(
  ctx: Context,
  publisher: InspectorStatePublisher,
  limits: CordisTreeLimits,
): () => void {
  return observeCordisTree(ctx, (snapshot) => {
    publisher.setState(CORDIS_TREE_TOPIC, snapshot as unknown as InspectorJsonValue)
  }, limits)
}
