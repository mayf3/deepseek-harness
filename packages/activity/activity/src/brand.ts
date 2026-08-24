/**
 * dsh-activity' owned branded id, carried across the registry, the observation
 * wire, and correlation metadata on other domains' rows.
 *
 * It lives in its own leaf because the package root reaches `dsh-agent`
 * through the owner and listener signatures, which a Client program cannot
 * resolve even as a type. A browser-safe consumer imports the id here;
 * `Branded<B>` itself comes from the zero-dependency `@deepseek-ai/dsh-brand`.
 *
 * @module @deepseek-ai/dsh-activity/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Identifies one observable activity. The registry generates `<kind>-N`;
 * predictable ids rely on owner authorization rather than secrecy.
 */
export type ActivityId = Branded<'ActivityId'>

/**
 * Brand a string as a {@link ActivityId}.
 * @param id - the raw process-id string (the registry generates `<kind>-N`).
 * @returns the same string, branded; no validation is performed.
 */
export function ActivityId(id: string): ActivityId {
  return id as ActivityId
}
