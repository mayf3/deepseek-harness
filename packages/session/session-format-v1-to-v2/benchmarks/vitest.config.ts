import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../../vitest.shared.ts'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/** Manual deterministic unit lane for benchmark options and statistics only. */
export default defineConfig({
  root,
  plugins: [standardDecoratorPlugin()],
  resolve: { tsconfigPaths: true },
  test: {
    execArgv: vitestExecArgv,
    include: ['packages/session/session-format-v1-to-v2/benchmarks/acceptance.spec.ts'],
    pool: 'forks',
  },
})
