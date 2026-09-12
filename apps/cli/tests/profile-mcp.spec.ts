/** MCP resource ownership across the resolved shipped profile templates. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  composeEntries, loadOverlayPatches, loadProfile, loadProfileDirectory, PROFILE_TEMPLATES,
} from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../../desktop/src/project-manager.ts'

const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const resourcePackage = '@deepseek-ai/dsh-mcp-resources'

describe('shipped MCP resource composition', () => {
  it.each(Object.keys(PROFILE_TEMPLATES))('%s carries one shared resource consumer without a server', (name) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-mcp-'))
    try {
      const profile = loadProfile('dsh', name, installAnchor, home)
      const warnings: string[] = []
      const rows = composeEntries([
        ...profile.layers.map(layer => layer.patches),
        profile.patches,
      ], message => warnings.push(message))

      expect(rows.filter(row => row.name === resourcePackage)).toEqual([
        { id: 'mcp-resources', name: resourcePackage },
      ])
      expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
      expect(warnings).toEqual([])

      const owners = profile.layers.filter((layer) => {
        const manifest = JSON.parse(readFileSync(join(layer.packageDir, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>
        }
        return manifest.dependencies?.[resourcePackage] !== undefined
      })
      expect(owners.map(owner => owner.packageName)).toEqual([
        name === 'sdk-minimal' ? '@deepseek-ai/dsh-sdk-minimal' : '@deepseek-ai/dsh-base',
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('Desktop retains one shared resource consumer after its host overlay', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-mcp-'))
    try {
      const profileDir = join(home, 'profiles', 'desktop')
      createPluginProfile(profileDir)
      const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
      const overlay = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
      const warnings: string[] = []
      const rows = composeEntries([
        ...profile.layers.map(layer => layer.patches),
        profile.patches,
        loadOverlayPatches('dsh desktop', overlay),
      ], message => warnings.push(message))

      expect(rows.filter(row => row.name === resourcePackage)).toEqual([
        { id: 'mcp-resources', name: resourcePackage },
      ])
      expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
      expect(rows.find(row => row.id === 'webserver')?.disabled).toBe(true)
      expect(warnings).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
