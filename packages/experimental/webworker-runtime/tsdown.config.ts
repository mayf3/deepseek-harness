import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { MODULE_PROXIES, MODULE_PROXY_PREFIXES } from './src/module-proxies.ts'

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

/**
 * Resolve the module proxy table at bundle time: every Node builtin or
 * replaced external the worker graph imports lands on its `./node/` proxy,
 * so `lib/worker.js` is one self-contained ES module a deployment serves and
 * loads with `new Worker(url, { type: 'module' })`.
 */
const moduleProxyPlugin = {
  name: 'dsh-module-proxies',
  resolveId(source: string): string | null {
    const exact = MODULE_PROXIES[source]
    if (exact !== undefined) return here(`./src/${exact.replace('./', '')}`)
    for (const [prefix, replacement] of Object.entries(MODULE_PROXY_PREFIXES)) {
      if (source.startsWith(prefix)) return here(`./src/${replacement.replace('./', '')}`)
    }
    return null
  },
}

/**
 * Three artifacts from one pipeline: the runtime library the worker bundle is
 * built from (neutral), the worker bundle itself (browser, single file), and
 * the page half a deployment's shell imports (browser).
 */
export default defineConfig([{
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}, {
  // The invariant companion ships as its own bundle, like every package,
  // from the tsc-emitted artifact plane the root build also consumes.
  entry: ['lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}, {
  // The worker artifact: the host tree's Node-compatibility layer plus the
  // assembly, bundled whole — a worker served from a static URL can fetch no
  // sibling chunk.
  entry: ['src/worker.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  fixedExtension: false,
  dts: false,
  clean: false,
  noExternal: [/.*/],
  plugins: [moduleProxyPlugin],
  outputOptions: { inlineDynamicImports: true },
}, {
  // Page half: an ordinary browser ES module the deployment's page imports. It
  // is not a `dsh.client` graph row — it installs the module loader the graph is
  // loaded through, so it cannot be loaded by it. Workspace peers stay external
  // so the page keeps one instance of each.
  entry: ['src/client/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { entryFileNames: 'client.js' },
}])
