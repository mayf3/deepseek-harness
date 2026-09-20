/** File association results and explicit handler authorization at the native command adapter. */
import { describe, expect, it, vi } from 'vitest'
import { nativeFileApplications, openNativeFileApplication } from '../src/file-applications.ts'

const application = { id: '/Applications/Music.app', name: 'Music', default: true, icon: null }
const signal = new AbortController().signal

describe('native file associations', () => {
  it('passes file paths as arguments and preserves the desktop default', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify([application]), stderr: '' }))
    const path = '/tmp/中文 $(touch nope).mp3'
    await expect(nativeFileApplications(path, signal, { platform: 'darwin', run })).resolves.toEqual([application])
    expect(run).toHaveBeenCalledWith('/usr/bin/osascript', ['-l', 'JavaScript', '-e', expect.any(String), path], signal)
  })

  it.each(['{}', '[null]', '[{"id":1}]', JSON.stringify([{ ...application, icon: 'javascript:alert(1)' }])])('rejects malformed native output %s', async (stdout) => {
    await expect(nativeFileApplications('/file.mp3', signal, {
      platform: 'darwin', run: async () => ({ stdout, stderr: '' }),
    })).rejects.toThrow()
  })

  it('launches only a currently registered application with argv', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify([application]), stderr: '' }))
    await openNativeFileApplication('/file.mp3', application.id, signal, { platform: 'darwin', run })
    expect(run).toHaveBeenLastCalledWith('/usr/bin/open', ['-a', application.id, '/file.mp3'], signal)
    run.mockClear()
    await expect(openNativeFileApplication('/file.mp3', '/arbitrary.app', signal, { platform: 'darwin', run })).rejects.toThrow('not registered')
    expect(run).toHaveBeenCalledOnce()
  })

  it('does not query after cancellation or on unsupported platforms', async () => {
    const run = vi.fn()
    await expect(nativeFileApplications('/file.mp3', signal, { platform: 'freebsd', run })).resolves.toEqual([])
    await expect(nativeFileApplications('/file.mp3', AbortSignal.abort(), { platform: 'darwin', run })).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})
