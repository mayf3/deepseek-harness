/** Source-side CDP capability declarations for the Host realm. */

import type { InspectorSourceCapability } from '../../shared/bridge/messages/observation.ts'
import { consoleBridgeCapability } from './console.ts'
import { debuggerBridgeCapability } from './debugger.ts'
import { heapProfilerBridgeCapability } from './heap-profiler.ts'
import { profilerBridgeCapability } from './profiler.ts'
import { runtimeBridgeCapability } from './runtime.ts'
import { sourcesBridgeCapability } from './sources.ts'

/**
 * Collect Host source-bridge capabilities.
 * @param origin - Unused Host origin supplied for parity with the Client adapter.
 * @param hasSources - Unused source availability supplied for parity with the Client adapter.
 * @returns No capabilities because the Worker attaches to Host V8 directly.
 */
export function bridgeCapabilities(origin: string, hasSources: boolean): readonly InspectorSourceCapability[] {
  return [
    runtimeBridgeCapability(origin),
    consoleBridgeCapability(),
    sourcesBridgeCapability(hasSources),
    debuggerBridgeCapability(),
    profilerBridgeCapability(),
    heapProfilerBridgeCapability(),
  ].filter((capability): capability is InspectorSourceCapability => capability !== undefined)
}
