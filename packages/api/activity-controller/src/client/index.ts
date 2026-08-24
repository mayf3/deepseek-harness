/** Activity-specific adapter for the Gateway-owned snapshot stream lifecycle. */

import type { Context } from '@deepseek-ai/cordis'
import {
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { ActivityControlFrame } from '../types.ts'
import { ClientActivityModel } from './model.ts'
import { ClientActivityFeed } from './service.ts'
import type { ActivityRemote } from './service.ts'

export type { ActivityFeedPhase, ActivityFeedSnapshot, ObservedActivity } from './model.ts'
export type { ActivityFeedSource, ActivityRemote, IActivityFeed } from './service.ts'
export type { ActivityId } from '@deepseek-ai/dsh-activity/brand'
export type { ActivityRow } from '../types.ts'

type ActivityStreamRemote = Pick<ClientRemote, '$stream'> & { readonly activity: ActivityRemote }

type ActivityBaselineFrame = Extract<ActivityControlFrame, { type: 'baseline' }>
type ActivityRowsFrame = Extract<ActivityControlFrame, { type: 'rows' }>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** React-free client activity roster and observation control. */
    activityFeed: import('./service.ts').IActivityFeed
  }
}

/** Required Client Remote services. */
export const inject = ['remote', 'remote.activity']

/**
 * Install the client activity model, its service face, and the reconnecting
 * roster stream.
 * @param ctx - client root Context.
 */
export function apply(ctx: Context): void {
  const raw = ctx.remote as ActivityStreamRemote
  // Resolve the child namespace to a concrete value while this plugin's
  // context is current: later stream (re)opens run on caller stacks (a React
  // event, a carrier retry) whose dynamic context has not declared
  // `remote.activity`, and a property access there fails the inject check.
  const remote: ActivityStreamRemote = {
    $stream: options => raw.$stream(options),
    activity: raw.activity,
  }
  const model = new ClientActivityModel()
  new ClientActivityFeed(ctx, remote, model)
  const control = createActivityRosterStream(remote, model)
  control.start()
  ctx.effect(
    () => async () => { await control.dispose() },
    'activity-controller.client.control',
  )
}

/**
 * Create the reconnecting roster stream feeding one client model.
 * @param remote - generated activity namespace and Gateway stream factory.
 * @param model - roster sink.
 * @returns an unstarted stream owned by the client activity runtime.
 */
export function createActivityRosterStream(
  remote: ActivityStreamRemote,
  model: ClientActivityModel,
): RemoteSnapshotStream<ActivityBaselineFrame, ActivityRowsFrame> {
  const stream = remote.$stream<ActivityControlFrame>({
    name: 'activity roster stream',
    open: signal => remote.activity.control(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('activity roster stream ended without a terminal result')
      : new Error('activity roster stream ended before its opening baseline'),
  })
  return new RemoteSnapshotStream<ActivityBaselineFrame, ActivityRowsFrame>(stream, {
    name: 'activity roster stream',
    isSnapshot: (frame): frame is ActivityBaselineFrame => frame.type === 'baseline',
    replace: (frame) => { model.replaceBaseline(frame.activities) },
    update: (frame) => { model.replaceBucket(frame.sessionId, frame.activities) },
    failed: () => {
      // The previous roster stays published while the stream retries; a
      // terminal protocol failure leaves the last snapshot in place.
    },
  })
}
