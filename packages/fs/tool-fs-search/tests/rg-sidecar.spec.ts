import { describe, expect, it, vi } from 'vitest'

const existsSync = vi.hoisted(() => vi.fn(() => true))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync }
})

vi.mock('@vscode/ripgrep', () => new Proxy({}, {
  get() {
    throw new Error('the platform package must not load when the executable sidecar exists')
  },
}))

import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search'

describe('single-executable ripgrep resolution', () => {
  it('uses the native sidecar beside the current executable', async () => {
    const sidecar = `${process.execPath}-rg`

    await expect(resolveRgPath()).resolves.toBe(sidecar)
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })
})
