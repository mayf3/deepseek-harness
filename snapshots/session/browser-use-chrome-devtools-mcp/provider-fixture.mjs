/** Replace only the external MCP executable; retain the shipped provider and browser runtime. */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const name = 'browser-provider-fixture'
export const inject = ['browserUse', 'agents', 'tools']

export async function apply(ctx) {
  ctx.effect(() => {
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        return specifier === 'chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'
          ? { url: pathToFileURL(resolve('cli.js')).href, shortCircuit: true }
          : nextResolve(specifier, context)
      },
    })
    return () => hooks.deregister()
  }, 'browser-fixture.executable')
  const provider = await import('@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp')
  await ctx.plugin(provider, { mode: 'launch' })
}
