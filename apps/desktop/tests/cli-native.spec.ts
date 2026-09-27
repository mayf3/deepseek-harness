/** Real native command/installer exclusion with isolated application directories. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest'
import { prepareDesktopCli } from '../scripts/prepare-cli.ts'
import { DesktopCliBusyError, DesktopCliUpdateGuard } from '../src/cli-update-guard.ts'

let prepared: string
beforeAll(() => {
  prepared = mkdtempSync(join(tmpdir(), 'dsh-cli-compiled-'))
  prepareDesktopCli(prepared, { platform: process.platform, arch: process.platform === 'win32' ? 'x64' : process.arch })
})
afterAll(() => { if (prepared !== undefined) rmSync(prepared, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-cli-installation-')))
  const application = join(root, 'Application with spaces.app')
  const resources = join(application, ...process.platform === 'darwin' ? ['Contents', 'Resources'] : ['resources'])
  const cli = join(resources, 'runtime', 'cli')
  cpSync(prepared, cli, { recursive: true })
  const electron = join(application, ...process.platform === 'darwin' ? ['Contents', 'MacOS', 'DeepSeek Harness']
    : [process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'DeepSeek Harness'])
  mkdirSync(dirname(electron), { recursive: true })
  if (process.platform === 'win32') copyFileSync(process.execPath, electron)
  else symlinkSync(process.execPath, electron)
  const entry = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(join(dirname(entry), 'package.json'), '{"type":"module"}\n')
  writeFileSync(entry, [
    "import { writeFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    "if (args[0] === 'wait') {",
    "  process.on('SIGINT', () => { writeFileSync(args[1], 'interrupted'); process.exit(130) })",
    "  process.stdout.write('READY\\n')",
    '  process.stdin.resume()',
    "  process.stdin.once('data', () => { process.exit(0) })",
    '} else {',
    '  const chunks = []',
    '  for await (const chunk of process.stdin) chunks.push(chunk)',
    "  process.stdout.write(JSON.stringify({args, cwd:process.cwd(), value:process.env.DSH_CLI_TEST_VALUE, input:Buffer.concat(chunks).toString('hex')}))",
    "  process.stderr.write('separate stderr\\n')",
    '  process.exitCode = 23',
    '}',
    '',
  ].join('\n'))
  const children: ChildProcessWithoutNullStreams[] = []
  const exits: Promise<unknown>[] = []
  onTestFinished(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await Promise.all(exits)
    await rm(root, { recursive: true, force: true, maxRetries:10, retryDelay:100 })
  })
  const command = join(cli, 'bin', process.platform === 'win32' ? 'dsh.exe' : 'dsh')
  const control = join(cli, process.platform === 'win32' ? 'cli-control.exe' : 'cli-control')
  function start(args: string[]) {
    const child = spawn(command, args, {
      cwd: root, env: { ...process.env, DSH_CLI_TEST_VALUE: 'kept' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    exits.push(closed)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (text: string) => { stdout += text })
    child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr += text })
    return { child, closed, stdout: () => stdout, stderr: () => stderr }
  }
  return { root, cli, command, control, start }
}

async function ready(run: ReturnType<ReturnType<typeof fixture>['start']>): Promise<void> {
  if (run.stdout().includes('READY\n')) return
  await new Promise<void>((resolve, reject) => {
    const data = () => { if (run.stdout().includes('READY\n')) finish() }
    const close = () => { finish(new Error(run.stderr() || 'CLI exited before readiness')) }
    const finish = (error?: Error) => {
      run.child.stdout.off('data', data)
      run.child.off('close', close)
      if (error === undefined) resolve()
      else reject(error)
    }
    run.child.stdout.on('data', data)
    run.child.once('close', close)
  })
}

it('preserves arguments, cwd, environment, binary input, stderr and exit status', async () => {
  const f = fixture()
  const args = ['hello world', 'quote"inside', 'trailing\\', '中文 🚀', '%PATH%', '']
  const run = f.start(args)
  const input = Buffer.from([0, 1, 10, 255])
  run.child.stdin.end(input)
  const { code, signal } = await run.closed
  expect(signal).toBeNull()
  expect(code, run.stderr()).toBe(23)
  expect(JSON.parse(run.stdout())).toEqual({ args, cwd: f.root, value: 'kept', input: input.toString('hex') })
  expect(run.stderr()).toBe('separate stderr\n')
})

it('allows concurrent commands and refuses an update until all commands exit', async () => {
  const f = fixture()
  const first = f.start(['wait', join(f.root, 'first')])
  const second = f.start(['wait', join(f.root, 'second')])
  await Promise.all([ready(first), ready(second)])
  await expect(DesktopCliUpdateGuard.acquire(f.control, '1.2.3')).rejects.toBeInstanceOf(DesktopCliBusyError)
  first.child.stdin.end('done')
  await first.closed
  await expect(DesktopCliUpdateGuard.acquire(f.control, '1.2.3')).rejects.toBeInstanceOf(DesktopCliBusyError)
  second.child.stdin.end('done')
  await second.closed
  const guard = await DesktopCliUpdateGuard.acquire(f.control, '1.2.3')
  await guard.cancel()
})

it('excludes new starts during preparation and admits them after cancellation', async () => {
  const f = fixture()
  const guard = await DesktopCliUpdateGuard.acquire(f.control, '1.2.3')
  onTestFinished(() => guard.cancel())
  const blocked = f.start([])
  blocked.child.stdin.end()
  expect((await blocked.closed).code).toBe(75)
  expect(blocked.stderr()).toContain('update is in progress')
  await guard.cancel()
  const resumed = f.start([])
  resumed.child.stdin.end()
  expect((await resumed.closed).code, resumed.stderr()).toBe(23)
})

it('keeps the old generation blocked after handoff and admits the installed successor', async () => {
  const f = fixture()
  const guard = await DesktopCliUpdateGuard.acquire(f.control, '1.2.3')
  onTestFinished(() => guard.release())
  await guard.handoff()
  await guard.release()
  const blocked = f.start([])
  blocked.child.stdin.end()
  expect((await blocked.closed).code).toBe(75)
  writeFileSync(join(f.cli, 'generation'), 'successor-generation\n')
  const successor = f.start([])
  successor.child.stdin.end()
  expect((await successor.closed).code, successor.stderr()).toBe(23)
})

it('removes only the cancelled handoff and permits a retry', async () => {
  const f = fixture()
  const guard = await DesktopCliUpdateGuard.acquire(f.control, '1.2.3')
  await guard.handoff()
  await guard.cancel()
  const retry = await DesktopCliUpdateGuard.acquire(f.control, '1.2.3')
  await retry.cancel()
  const run = f.start([])
  run.child.stdin.end()
  expect((await run.closed).code, run.stderr()).toBe(23)
})

it.skipIf(process.platform === 'win32')('lets Node handle SIGINT before releasing its lease', async () => {
  // Windows Ctrl-C requires a real console; its installed-console smoke owns that case.
  const f = fixture()
  const marker = join(f.root, 'interrupted')
  const run = f.start(['wait', marker])
  await ready(run)
  run.child.kill('SIGINT')
  const { code, signal } = await run.closed
  expect(code).toBe(130)
  expect(signal).toBeNull()
  expect(readFileSync(marker, 'utf8')).toBe('interrupted')
  const guard = await DesktopCliUpdateGuard.acquire(f.control, '1.2.3')
  await guard.cancel()
})
