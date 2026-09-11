#!/usr/bin/env node
/** Private entry owned by the Python single-file runtime packaging. */

const selectorName = 'DSH_SUBPROCESS_RUNNER'
const selection = process.env[selectorName]

if (process.env.DSH_CODE_RUNTIME_NODE === '1') {
  Reflect.deleteProperty(process.env, 'DSH_CODE_RUNTIME_NODE')
  await import('@deepseek-ai/dsh-code-runtime-node/process')
} else if (selection === undefined) {
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
  await runCli()
} else {
  Reflect.deleteProperty(process.env, selectorName)
  const { runSelectedSubprocessRunner } = await import('@deepseek-ai/dsh-subprocess-local/runner')
  await runSelectedSubprocessRunner(selection)
}
