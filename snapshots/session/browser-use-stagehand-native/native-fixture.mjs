/** Replace only external Stagehand; the profile runs the real DSH provider and model adapter. */
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

export const name = 'browser-use-stagehand-native-fixture'
export const inject = ['browserUse', 'agents', 'sessions', 'llm', 'tools', 'systemPrompt']

export async function apply(ctx) {
  const fixture = new URL('../../../packages/experimental/browser-use-stagehand-native/tests/fixtures/stagehand.ts', import.meta.url).href
  ctx.effect(() => {
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        return specifier === '@browserbasehq/stagehand'
          ? { url: fixture, shortCircuit: true }
          : nextResolve(specifier, context)
      },
      // SDK snapshots run built DSH under plain Node; only this external fixture needs transpilation.
      load(url, context, nextLoad) {
        if (url !== fixture) return nextLoad(url, context)
        return {
          format: 'module',
          source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          }).outputText,
          shortCircuit: true,
        }
      },
    })
    return () => hooks.deregister()
  }, 'browser-use-stagehand-native-fixture.module')
  const provider = await import('@deepseek-ai/dsh-experimental-browser-use-stagehand-native')
  await ctx.plugin(provider, { mode: 'launch' })
}
