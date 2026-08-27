/**
 * `node:https` for the worker. Nothing here dials TLS: the only module that reaches for this one is
 * `dsh-http-proxy`, whose agent factory serves SDKs that post through Node's core HTTP modules —
 * a path the worker never takes, since its own requests go through `fetch`.
 */

/** Constructible placeholder: an agent built here would have no transport to pool. */
export class Agent {
  /** Teardown is accepted so disposal paths stay quiet. */
  destroy(): void {
    // No socket pool was ever held.
  }
}

/**
 * TLS requests have no carrier in a worker.
 * @returns Never — it throws naming the unavailable member.
 */
export function request(): never {
  throw new Error('web-preview: node:https.request is not available in the worker host')
}

/**
 * Counterpart of {@link request} for the GET shorthand.
 * @returns Never — it throws naming the unavailable member.
 */
export function get(): never {
  throw new Error('web-preview: node:https.get is not available in the worker host')
}

/**
 * TLS listening belongs to the host, not to a worker.
 * @returns Never — it throws naming the unavailable member.
 */
export function createServer(): never {
  throw new Error('web-preview: node:https.createServer is not available in the worker host')
}

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/**
 * The `node:https` declarations this module stands in for. `Agent` keeps this module's own class:
 * Node declares it over a socket pool that a placeholder holding no connection cannot expose.
 */
type NodeFace = Partial<Omit<typeof import('node:https'), 'Agent'>> & Record<'Agent', unknown>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default { Agent, request, get, createServer } satisfies NodeFace
