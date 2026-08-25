/** Static adjacent-version Session format migrations shipped by this build. */

import type { SessionFormatMigration } from '../format-decoder.ts'

/** Ordered durable format migrations; format v0 is current, so the chain is empty. */
export const SESSION_FORMAT_MIGRATIONS: readonly SessionFormatMigration[] = Object.freeze([])
