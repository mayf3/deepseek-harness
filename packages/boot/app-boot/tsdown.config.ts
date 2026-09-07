import { defineConfig } from 'tsdown'

/**
 * Embed Include while keeping Loader external so the built include tree and
 * app host bind to one Loader peer.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      alwaysBundle: ['@deepseek-ai/cordis-plugin-include'],
    },
  },
  {
    // The package probe's child entry ships beside the lib as its own
    // bundle; the probe path-loads it relative to its own module.
    entry: { 'probe-child': 'lib/types/probe-child.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    // The patch-file parser and writer ship as the `./patch-file` export,
    // so the agent-preset roster and the plugin manager load them without
    // the boot entry.
    entry: { 'patch-file': 'lib/types/patch-file.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
