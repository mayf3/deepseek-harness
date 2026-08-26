/** Production documentation-site build with project-owned output preparation. */

import { rmSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vitepress'

const websiteRoot = resolve(import.meta.dirname)
type DocSiteBuildOptions = NonNullable<Parameters<typeof build>[1]>

/**
 * Remove one documentation build output without permitting the site root or an outside path.
 * @param siteRoot - VitePress site root that owns the output.
 * @param outDir - Resolved VitePress output directory.
 * @throws When `outDir` is not a proper child of `siteRoot`.
 */
export function cleanDocSiteOutput(siteRoot: string, outDir: string): void {
  const root = resolve(siteRoot)
  const output = resolve(outDir)
  const child = relative(root, output)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`build-doc-site: output directory ${JSON.stringify(output)} must be a child of site root ${JSON.stringify(root)}.`)
  }
  rmSync(output, { recursive: true, force: true })
}

/**
 * Create VitePress build options that remove the resolved output directory before bundling.
 * @param siteRoot - VitePress site root to build.
 * @param mpa - Whether to use VitePress's multi-page application build.
 * @returns VitePress options with project-owned output preparation.
 */
export function docSiteBuildOptions(siteRoot: string, mpa: boolean): DocSiteBuildOptions {
  const root = resolve(siteRoot)
  return {
    ...mpa ? { mpa: 'true' } : {},
    onAfterConfigResolve(siteConfig) {
      cleanDocSiteOutput(root, siteConfig.outDir)
    },
  }
}

async function buildDocSite(siteRoot: string, mpa: boolean): Promise<void> {
  const root = resolve(siteRoot)
  await build(root, docSiteBuildOptions(root, mpa))
}

function parseMpa(args: string[]): boolean {
  if (args.length === 0) return false
  if (args.length === 1 && args[0] === '--mpa') return true
  throw new Error(`build-doc-site: expected no arguments or --mpa, got ${JSON.stringify(args)}.`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await buildDocSite(websiteRoot, parseMpa(process.argv.slice(2)))
}
