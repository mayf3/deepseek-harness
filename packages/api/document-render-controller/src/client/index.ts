/** Mount the Host documentRender namespace for the Client connection lifetime. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import documentRenderRemote from '@deepseek-ai/dsh-api-document-render-controller/remote'

/** Remote carrier used by the Office preview plugin. */
export const inject = ['remote']

/**
 * Register the generated documentRender Remote.
 * @param ctx - Client context with its Remote carrier.
 * @returns disposer that removes the namespace and joins pending requests.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return ctx.remote.$mount(documentRenderRemote)
}
