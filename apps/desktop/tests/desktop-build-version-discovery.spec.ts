import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  desktopBuildDateSegment,
  suggestDesktopBuildVersion,
} from '../scripts/desktop-build-version-discovery.ts'

const PRODUCT = '0.1.6-alpha.2'
const DATE = '20260921'

async function artifactsWith(names: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovery-'))
  for (const name of names) await writeFile(join(directory, name), '')
  return directory
}

describe('desktop build version discovery', () => {
  it('formats the date segment in the build host time zone', () => {
    expect(desktopBuildDateSegment(new Date(2026, 8, 21))).toBe('20260921')
    expect(desktopBuildDateSegment(new Date(2026, 0, 5))).toBe('20260105')
  })

  it('starts at one when nothing is taken', async () => {
    const artifactsRoot = await artifactsWith([])
    await expect(suggestDesktopBuildVersion({ productVersion: PRODUCT, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRODUCT}.${DATE}.1`)
  })

  it('numbers after the highest local artifact for the same date', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRODUCT}.${DATE}.1-win-x64.exe`,
      `deepseek-harness-${PRODUCT}.${DATE}.2-win-x64.exe`,
      `deepseek-harness-${PRODUCT}.${DATE}.10-win-x64.exe`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRODUCT, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRODUCT}.${DATE}.11`)
  })

  it('ignores artifacts from another date or product version', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRODUCT}.20260920.7-win-x64.exe`,
      `deepseek-harness-0.1.5-alpha.1.${DATE}.9-win-x64.exe`,
      `deepseek-harness-${PRODUCT}-win-x64.exe`,
      'unrelated.exe',
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRODUCT, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRODUCT}.${DATE}.1`)
  })

  it('reads macOS artifact names too', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRODUCT}.${DATE}.3-mac-arm64.dmg`,
      `deepseek-harness-${PRODUCT}.${DATE}.3-mac-arm64.zip`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRODUCT, target: 'mac-arm64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRODUCT}.${DATE}.4`)
  })

  it('refuses to number a stable product version, whose numbering is not even a version', async () => {
    const artifactsRoot = await artifactsWith([])
    // 0.1.6.20260921.1 has a fourth release number, which semver does not accept at all.
    await expect(suggestDesktopBuildVersion({ productVersion: '0.1.6', target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .rejects.toThrow(/is not a version/u)
  })
})
