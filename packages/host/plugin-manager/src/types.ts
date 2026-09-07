/**
 * Client-safe payloads, events, and failure codes of the `plugins` Remote:
 * the plugin manager's own vocabulary, re-exported unchanged, plus its codes
 * declared in the Remote failure map so a client narrows a failure's
 * `details` by code.
 * @module @deepseek-ai/dsh-host-plugin-manager/types
 */

import type { PluginOperationDetailsMap } from '@deepseek-ai/dsh-plugin-manager/types'

export type * from '@deepseek-ai/dsh-plugin-manager/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No profile runtime is composed, so there is no profile to manage. */
    'plugins/unavailable': PluginOperationDetailsMap['plugins/unavailable']
    /** The package is not a profile dependency. */
    'plugins/not-installed': PluginOperationDetailsMap['plugins/not-installed']
    /** The package cannot be enabled or added, with the probe's reason. */
    'plugins/not-enableable': PluginOperationDetailsMap['plugins/not-enableable']
    /** Enabling composed the bundle and the tree rejected it; the layer list was restored. */
    'plugins/enable-failed': PluginOperationDetailsMap['plugins/enable-failed']
    /** pnpm exited non-zero, could not be spawned, or timed out. */
    'plugins/install-failed': PluginOperationDetailsMap['plugins/install-failed']
    /** The row id is already taken in the target user layer. */
    'plugins/row-conflict': PluginOperationDetailsMap['plugins/row-conflict']
    /** Another mutation is still running; the manager runs one at a time and refuses rather than queues. */
    'plugins/busy': PluginOperationDetailsMap['plugins/busy']
    /** `node_modules` cannot change while a session runs; `running` counts the agents in `running` status. */
    'plugins/agents-running': PluginOperationDetailsMap['plugins/agents-running']
  }
}

export {}
