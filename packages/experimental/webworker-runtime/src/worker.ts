/**
 * Dedicated Web Worker entry. The Node-compatibility layer this app owns is
 * handed to the host assembly as the module table plus the captured request
 * listener; the assembly owns everything else (process global, VFS image,
 * Cordis tree, tunnel server).
 *
 * The assembly needs the image location before it can exist, and it arrives in
 * the tunnel's opening `init` frame — this bundle reads nothing from its own
 * URL, so the deployment decides where both the bundle and the image live.
 * Messages before `init` queue here; requests during boot queue inside the
 * host, which attaches its handler before its first await.
 */
// Straight to the assembly, not through the package barrel: the barrel also
// publishes the pack-time transform, whose acorn dependency would then be bundled
// into this worker — which never parses JavaScript.
import { createWorkerHost } from './worker-host.ts'
import './node/builtin_modules/implemented/buffer.ts'
import { alsCausality, runAtAsyncContextRoot } from './node/builtin_modules/implemented/async_hooks.ts'
import { installAsyncContextHooks } from './polyfill/async-context/async-context-hooks.ts'
import { createNodeBuiltins, REPLACED_PREFIXES } from './node/builtins.ts'
import { whenRequestListener } from './node/builtin_modules/implemented/http.ts'
import { installTimerGlobals } from './node/globals/timers.ts'

// Before the timer globals, so the wrappers close over the patched platform.
installAsyncContextHooks()
installTimerGlobals()

let host: { handleMessage(data: unknown): void } | undefined
const pending: unknown[] = []

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null
  if (host === undefined && data !== null && typeof data === 'object' && data.t === 'init') {
    if (typeof data.image !== 'string') {
      throw new Error('webworker: init frame needs a string image url')
    }
    const created = createWorkerHost({
      staticModules: createNodeBuiltins(),
      staticModulePrefixes: REPLACED_PREFIXES,
      requestListener: whenRequestListener,
      alsCausality,
      image: data.image,
    })
    host = created
    for (const queued of pending) {
      runAtAsyncContextRoot(() => { created.handleMessage(queued) })
    }
    pending.length = 0
    created.start().catch(() => {
      // start() already reported the failure to the page through tunnel.fail;
      // nothing else can reach this rejection, so only the duplicate
      // unhandled-rejection noise is dropped here.
    })
    return
  }
  if (host === undefined) {
    pending.push(event.data)
    return
  }
  const ready = host
  // A tunnel request belongs to no boundary: dispatch it at the context root so
  // it cannot inherit whatever ran just before it on this thread.
  runAtAsyncContextRoot(() => { ready.handleMessage(event.data) })
})
