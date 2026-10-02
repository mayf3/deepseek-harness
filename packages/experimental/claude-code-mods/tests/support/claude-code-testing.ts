/**
 * `claude-code/testing` as this repository's Vitest setup provides it to the
 * example mods: Claude Code's `describe`, `test`, `expect`, `mock`, and `tier`
 * over the published test kit. `test` hands each case a fresh kit for the mod
 * whose `tests/` folder holds the test file.
 * @module
 */

import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe as vitestDescribe, expect as vitestExpect, test as vitestTest } from 'vitest'
import type { ModPlugin } from '../../src/define-mod.ts'
import { createModTestKit, mock } from '../../src/testing.ts'
import type { ModTestKit, TestKitRaisers } from '../../src/testing.ts'
import type { ModDefinition } from '../../src/types.ts'

export { mock }
export type { ModTestKit, TestKitRaisers }

/** A test body as Claude Code hands it its arguments: the engine's `$` and a stub-registering `on`. */
export type ModTestBody = ($: TestKitRaisers, on: ModTestKit['on'], kit: ModTestKit) => Promise<void> | void

/** How `test` finds the mod under test for the current test file. */
let modUnderTest: ((testPath: string) => Promise<readonly (ModDefinition | ModPlugin)[]>) | undefined

/**
 * Name the mods `test` loads instead of inferring them from the test file's location.
 * @param resolver - maps the running test file to the mods to load; `undefined` restores inference.
 */
export function defineModTests(resolver: ((testPath: string) => Promise<readonly (ModDefinition | ModPlugin)[]>) | undefined): void {
  modUnderTest = resolver
}

/** Load the plugin two directories above a `tests/<name>.test.ts` file: `<mod>/index.ts` exporting a `defineMod` plugin. */
async function inferMod(testPath: string): Promise<readonly (ModDefinition | ModPlugin)[]> {
  const modDir = dirname(dirname(testPath))
  const namespace: unknown = await import(pathToFileURL(resolve(modDir, 'index.ts')).href)
  const plugin = (namespace as { default?: unknown }).default
  if (typeof plugin !== 'object' || plugin === null || !('definition' in plugin)) {
    throw new Error(`${modDir}/index.ts does not default-export a defineMod plugin`)
  }
  return [plugin as ModPlugin]
}

/** Vitest's `describe`, so a mod's test file imports one module. */
export const describe: typeof vitestDescribe = vitestDescribe

/** Vitest's `expect`, so a mod's test file imports one module. */
export const expect: typeof vitestExpect = vitestExpect

/**
 * Declare the tier the mod loads in. This host loads every mod as `user`; the call is accepted for source compatibility.
 * @param _tier - the declared tier.
 */
export function tier(_tier: string): void {}

/**
 * One test case against a fresh kit for the mod whose `tests/` folder holds this file.
 * @param name - the case name.
 * @param body - receives the engine's `$` raisers and the stub-registering `on`.
 */
export function test(name: string, body: ModTestBody): void {
  vitestTest(name, async () => {
    const testPath = vitestExpect.getState().testPath
    if (testPath === undefined) throw new Error('claude-code/testing: test() needs Vitest to know the test file path')
    const mods = await (modUnderTest ?? inferMod)(testPath)
    const kit = await createModTestKit({ mods })
    try {
      await body(kit.$, kit.on, kit)
    } finally {
      await kit.dispose()
    }
  })
}
