/** One-time custom-profile initialization from shipped templates. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import { initializeProfileFromDefault } from '../src/profile-boot.ts'

/** Run one assertion against a private Harness home and remove it afterwards. */
function withHome(assertion: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-from-default-'))
  try {
    assertion(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('initializeProfileFromDefault', () => {
  it.each(Object.entries(PROFILE_TEMPLATES))(
    'copies the %s template metadata into an independent profile',
    (source, template) => {
      withHome((home) => {
        initializeProfileFromDefault('custom', source, home)
        const dir = resolveProfileDir('custom', home)
        const manifest = readProfileManifest('test', dir)
        expect(manifest).toEqual({
          name: 'dsh-profile-custom',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: [...template.bundles], patchReload: template.patchReload } },
        })
        expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
        expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
      })
    },
  )

  it('does not copy the local source profile dependencies or user patch', () => {
    withHome((home) => {
      const sourceDir = resolveProfileDir('web', home)
      initProfile(sourceDir, ['local-bundle'], 'startup')
      const sourceManifest = readProfileManifest('test', sourceDir)
      sourceManifest.dependencies = { 'local-bundle': '1.0.0' }
      writeProfileManifest(sourceDir, sourceManifest)
      writeFileSync(join(sourceDir, PROFILE_PATCH_FILENAME), '- id: local-only\n  disabled: true\n')

      initializeProfileFromDefault('rescue', 'web', home)

      const targetDir = resolveProfileDir('rescue', home)
      const target = readProfileManifest('test', targetDir)
      expect(target.dependencies).toEqual({})
      expect(target.dsh?.profile).toEqual({
        bundles: [...PROFILE_TEMPLATES.web!.bundles],
        patchReload: PROFILE_TEMPLATES.web!.patchReload,
      })
      expect(readFileSync(join(targetDir, PROFILE_PATCH_FILENAME), 'utf8')).not.toContain('local-only')
    })
  })

  it('rejects an existing target without changing its files', () => {
    withHome((home) => {
      const dir = resolveProfileDir('rescue', home)
      initProfile(dir, ['existing-bundle'], 'startup')
      writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: existing\n  disabled: true\n')
      const paths = ['package.json', PROFILE_PATCH_FILENAME, 'pnpm-workspace.yaml'].map(file => join(dir, file))
      const before = paths.map(path => readFileSync(path))

      expect(() => {
        initializeProfileFromDefault('rescue', 'web', home)
      })
        .toThrow('profile "rescue" already exists')
      expect(paths.map(path => readFileSync(path))).toEqual(before)
    })
  })

  it.each(['unknown', 'toString'])('rejects unknown template %s without creating the target', (source) => {
    withHome((home) => {
      expect(() => {
        initializeProfileFromDefault('rescue', source, home)
      })
        .toThrow(`unknown default profile ${JSON.stringify(source)}`)
      expect(existsSync(resolveProfileDir('rescue', home))).toBe(false)
    })
  })
})
