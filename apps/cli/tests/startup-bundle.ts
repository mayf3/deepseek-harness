/** Installed bundle provenance for product-profile startup acceptance tests. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initProfile, loadOverlayPatches, PROFILE_TEMPLATES, readProfileManifest, writeProfileManifest, type ProfileLayer,
} from '@deepseek-ai/dsh-app-boot'

/**
 * Install a patch as a real profile dependency, preserving its module resolution anchors.
 * @param home - the scenario's isolated Harness home.
 * @param profile - the shipped profile under test.
 * @param patchFile - the fixture patch whose relative module names resolve at its source.
 * @param stage - whether this external bundle is required or optional at startup.
 */
export function stageStartupBundle(
  home: string,
  profile: 'web' | 'sdk' | 'headless',
  patchFile: string,
  stage: ProfileLayer['stage'] = 'runtime',
): void {
  const dir = join(home, 'profiles', profile)
  const template = PROFILE_TEMPLATES[profile]
  if (template === undefined) throw new Error(`Missing shipped profile template: ${profile}`)
  if (!existsSync(join(dir, 'package.json'))) initProfile(dir, template.bundles, template.patchReload)
  const name = '@fixture/startup-policy'
  const bundle = join(dir, 'node_modules', name)
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name, version: '1.0.0', private: true, type: 'module', dsh: { bundle: { patch: './cordis.patch.json', stage } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.json'), JSON.stringify(loadOverlayPatches('startup fixture', patchFile)))
  const manifest = readProfileManifest('startup fixture', dir)
  writeProfileManifest(dir, {
    ...manifest,
    dependencies: { ...manifest.dependencies, [name]: '1.0.0' },
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...manifest.dsh?.profile?.bundles ?? [], name] } },
  })
}
