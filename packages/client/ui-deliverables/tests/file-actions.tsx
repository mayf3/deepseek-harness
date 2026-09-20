/** Capture delivery action ownership without duplicating the opening-control implementation. */
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../src/client/index.ts'

/** Slot renderer exposing the owning route and gesture for component tests. */
export function renderFileActions(
  _name: 'deliverables.file.actions' | 'deliverables.review.file.actions',
  props: SlotMap['deliverables.file.actions']['owner'],
) {
  return props.available ? <button type="button" data-action-url={props.actionUrl} disabled={props.pending}
    onClick={() => { void props.onAction('open') }}>Native file action</button> : null
}
