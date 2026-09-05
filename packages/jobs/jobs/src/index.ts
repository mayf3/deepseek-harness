/**
 * The background-job Service Definition (`ctx.jobs`). It owns the contract for
 * job ids, session-scoped access, lifecycle state, the per-job output ring —
 * one bounded stream that the model consumes through a registry-kept cursor
 * and that any number of observers read at absolute byte offsets — and the
 * event stream announcing every commit, while producers retain their
 * execution resources. The process-local registry lives in
 * `@deepseek-ai/dsh-jobs-local`.
 * @module @deepseek-ai/dsh-jobs
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JobEvents, JobId, JobSpec, CallerJobs } from './types.ts'

export { JobId } from './types.ts'
export type {
  JobAppendOptions,
  JobChannel,
  JobChunk,
  JobEvent,
  JobEventFilter,
  JobEventListener,
  JobEvents,
  JobHandle,
  JobHooks,
  JobKillOptions,
  JobKind,
  JobKindMap,
  JobOutcome,
  JobOutputRead,
  JobOutputSource,
  JobRead,
  JobSettleCause,
  JobSourceRead,
  JobSpec,
  JobStatus,
  JobView,
  CallerJobs,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jobs: JobRegistry
  }
}

/**
 * Abstract background job registry. Subclass, implement the abstract members,
 * and load the subclass as a plugin — it registers as `ctx.jobs` (one
 * implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Registrations outlive producer and controller fibers. Owner and
 *   service disposal cancel live work and await compliant producers; a
 *   throwing teardown cancel force-fails only the record. Such settlements
 *   announce `cause: 'teardown'`, because a job whose owner is being destroyed
 *   has no reader left.
 * - Owned-job access is fenced by the owner's session id. Ids are
 *   predictable, so authorization — not secrecy — is the boundary.
 * - Settlement is first-wins: one terminal record, released waiters, then one
 *   round of contained event delivery, even against a late producer outcome.
 *   The `settled` event follows every released waiter, so a consumer that
 *   claims a settlement while waiting always claims before the event.
 * - {@link start} refuses work while no attached job controller serves the
 *   spec's owner, so a producer cannot start work that owner cannot collect
 *   or stop. One registry serves every composition in the process, so this
 *   question — and event delivery under `{ owners: 'scope' }` — is
 *   owner-relative rather than process-wide: registrations made from an
 *   unscoped context serve every owner, and registrations made under an agent
 *   composition's scope serve exactly the agents composed under it.
 * - Every job owns one output ring. Pull sources named by the spec are pumped
 *   by the registry and drained once more before settlement; pushed appends
 *   land whole. The model's consuming cursor and observers' absolute offsets
 *   read the same bytes and never disturb each other.
 * - Ring retention is bounded. Appends past the live cap drop the oldest
 *   retained bytes; a reader below the retained window gets a lossy read,
 *   never an error. Settlement trims retention to the settled cap and ends
 *   the stream; the ring has no separate lifecycle.
 */
export abstract class JobRegistry extends Service {
  constructor(ctx: Context) {
    // `abstract` erases at runtime, so a composition row naming this package
    // would register a ctx.jobs with no method implementations and fail far
    // from the misconfiguration. Fail loud at load instead.
    if (new.target === JobRegistry) {
      throw new Error('@deepseek-ai/dsh-jobs is the abstract job registry seam; load an implementation such as @deepseek-ai/dsh-jobs-local instead')
    }
    super(ctx, 'jobs')
  }

  /** Lifecycle and output events, filtered per subscription. */
  abstract readonly events: JobEvents

  /**
   * Preflight access, validation, owner cleanup, and implementation-owned
   * admission before starting and atomically registering work. Any preflight
   * rejection leaves no job id or execution resource. A throwing starter
   * leaves nothing registered; after it returns, registration cannot fail.
   * @param spec - job identity, owner, output sources, and synchronous starter.
   * @returns the registry-issued `<kind>-N` id.
   */
  abstract start(spec: JobSpec): JobId

  /**
   * Bind the caller's identity once and return its operations. A caller sees
   * its own jobs and every unowned job; an anonymous caller sees unowned jobs
   * only. The operations resolve visibility on every call, so they stay valid
   * as jobs come and go.
   * @param caller - the calling session, or `undefined` for an anonymous caller.
   * @returns the operations available to that caller.
   */
  abstract forCaller(caller: SessionId | undefined): CallerJobs

  /**
   * Attach an effect-scoped controller that can read and stop jobs. It serves the
   * owners its registering context's scope covers, and {@link start} refuses an
   * owner no attached controller serves.
   * @param name - diagnostic label; duplicate names remain independent.
   * @returns disposer that detaches this controller.
   */
  abstract attachController(name: string): () => void
}

export default JobRegistry
