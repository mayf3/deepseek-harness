/** Real Windows Shell discovery and invocation with a private file extension and a short-lived fixture application. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, onTestFinished } from 'vitest'
import { nativeFileApplications, openNativeFileApplication } from '../src/file-applications.ts'
import { runNativeCommand, type NativeCommandRunner } from '../src/runner.ts'

/** Encode fixture data without placing its quotes or Unicode in executable PowerShell text. */
function literal(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`
}

it.skipIf(process.platform !== 'win32')('queries and invokes a registered Windows handler through the system Shell', async ({ task }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-windows-association-'))
  const suffix = randomUUID().replaceAll('-', '')
  const extension = `.dsh${suffix}`
  const progId = `DSH.Test.${suffix}`
  const path = join(root, `测试 ' audio${extension}`)
  const marker = join(root, 'opened.json')
  const script = join(root, 'handler.cjs')
  const lifetime = new AbortController()
  const active = new Set<Promise<Awaited<ReturnType<NativeCommandRunner>>>>()
  const run: NativeCommandRunner = (command, args, signal) => {
    const task = runNativeCommand(command, args, signal)
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const runScript = async (source: string): Promise<void> => {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], lifetime.signal)
  }
  onTestFinished(async () => {
    lifetime.abort()
    await Promise.allSettled([...active])
    try {
      await runNativeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`
$root = [Microsoft.Win32.Registry]::CurrentUser
$root.DeleteSubKeyTree('Software\\Classes\\${extension}', $false)
$root.DeleteSubKeyTree('Software\\Classes\\${progId}', $false)
`, 'utf16le').toString('base64')], new AbortController().signal)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  await writeFile(path, 'test')
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ path: process.argv[2], pid: process.pid }));\n`)
  await runScript(`$ErrorActionPreference = 'Stop'
$root = [Microsoft.Win32.Registry]::CurrentUser
$key = $root.CreateSubKey('Software\\Classes\\${extension}')
$key.SetValue('', '${progId}'); $key.Dispose()
$key = $root.CreateSubKey('Software\\Classes\\${extension}\\OpenWithProgids')
$key.SetValue('${progId}', ''); $key.Dispose()
$key = $root.CreateSubKey('Software\\Classes\\${progId}\\shell\\open\\command')
$key.SetValue('', ${literal(`"${process.execPath}" "${script}" "%1"`)}); $key.Dispose()
`)
  const applications = await nativeFileApplications(path, lifetime.signal, { run })
  const expected = applications.find(app => app.id.toLowerCase() === process.execPath.toLowerCase())
  expect(expected).toMatchObject({ default: true, name: expect.any(String) as string })
  await openNativeFileApplication(path, expected!.id, lifetime.signal, { run })
  let opened: { path: string; pid: number } | undefined
  await vi.waitFor(async () => {
    opened = JSON.parse(await readFile(marker, 'utf8')) as { path: string; pid: number }
    expect(opened.path).toBe(path)
  }, { timeout: task.timeout })
  // Shell invocation does not own the application's lifetime; wait for this fixture's process to exit before removing its files.
  await vi.waitFor(() => { expect(() => process.kill(opened!.pid, 0)).toThrow() }, { timeout: task.timeout })
})
