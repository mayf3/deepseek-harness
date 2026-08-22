/**
 * Remote namespaces the Session cluster calls. One parameter for one concept:
 * the generated surface a Session and its manager reach the Host through.
 *
 * @module @deepseek-ai/dsh-client-runtime/client/sessions/remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

/** The generated Remote namespaces and Gateway stream factory a Session cluster uses. */
export type SessionRemotes = Pick<Context['remote'], '$stream' | 'commands' | 'session'>
