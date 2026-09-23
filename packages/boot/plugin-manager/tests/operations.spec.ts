/** The CLI and manager share package reconciliation, path anchoring and diagnostics. */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { expect, it, onTestFinished, vi } from 'vitest'
import { initProfile, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { anchorPathSpec, readProfileRegistry, runPluginCommand, runProfilePnpm, viewProfilePackage } from '../src/operations.ts'

/** What execa resolves for a run that settled. */
interface FakeOutcome {
  exitCode: number | undefined
  failed: boolean
  code?: string
  shortMessage?: string
}

/** The child execa hands back, including the descriptors an inherited CLI run reports as null. */
interface FakeChild {
  stdout: PassThrough | null
  stderr: PassThrough | null
  nodeChildProcess: EventEmitter
  kill?: () => boolean
}

const command = vi.hoisted(() => ({ run: vi.fn<(...args: unknown[]) => Promise<FakeOutcome> & FakeChild>() }))
vi.mock('execa', () => ({ execa: (...args: unknown[]) => command.run(...args) }))

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'manager-pnpm-'))
  onTestFinished(() => { command.run.mockReset(); rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  const installAnchor = join(home, 'package.json')
  writeFileSync(installAnchor, '{}\n')
  initProfile(dir, [])
  return { home, dir, context: { home, profile: 'test', installAnchor, cwd: home } }
}

function result(
  exitCode: number | undefined, output: string, mutate: () => void = () => {},
  details: { code?: string; shortMessage?: string } = {},
) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const raw = new EventEmitter()
  const done = Promise.resolve().then(() => {
    mutate()
    stdout.end(output)
    stderr.end()
    return { exitCode, failed: exitCode !== 0, ...details }
  })
  // A launch failure reports on the raw child, which never emits an exit; anything else exits once execa's promise settles.
  // Both arrive on a macrotask, so a fixture built before the run still reaches the listener the run attaches.
  if (details.code === undefined) {
    void done.then(() => { setTimeout(() => { raw.emit('exit', exitCode, null) }, 0) }, () => {})
  } else {
    setTimeout(() => { raw.emit('error', Object.assign(new Error('pnpm failed to launch'), { code: details.code })) }, 0)
  }
  return Object.assign(done, { stdout, stderr, nodeChildProcess: raw })
}

/** A child that printed once and never exits on its own: only the silence bound can end it. */
function silentChild(output: string, exitCode?: number) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const raw = new EventEmitter()
  const exit = Promise.withResolvers<{ exitCode: number | undefined; failed: boolean }>()
  const kill = () => {
    stdout.end()
    stderr.end()
    raw.emit('exit', exitCode ?? null, 'SIGTERM')
    exit.resolve({ exitCode, failed: exitCode !== 0 })
    return true
  }
  stdout.write(output)
  return Object.assign(exit.promise, { stdout, stderr, kill, nodeChildProcess: raw })
}

/** A child that exited while its pipes stay open, as a descendant that inherited them leaves them. */
function heldPipeChild(output: string) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const raw = new EventEmitter()
  const exit = Promise.withResolvers<{ exitCode: number; failed: boolean }>()
  let ended = 0
  // execa settles only once both pipes end, which the bounded drain forces by destroying them.
  for (const stream of [stdout, stderr]) {
    stream.on('close', () => {
      ended += 1
      if (ended === 2) exit.resolve({ exitCode: 0, failed: false })
    })
  }
  // The process exits as soon as the run watches the raw child, so a fixture the
  // test built before the run cannot emit past the listener the run attaches.
  let watched = false
  const watch = (): void => {
    if (watched) return
    watched = true
    setTimeout(() => { raw.emit('exit', 0, null) }, 0)
  }
  const on = raw.on.bind(raw)
  const once = raw.once.bind(raw)
  raw.on = (event, listener) => { const holder = on(event, listener); if (event === 'exit') watch(); return holder }
  raw.once = (event, listener) => { const holder = once(event, listener); if (event === 'exit') watch(); return holder }
  stdout.write(output)
  return Object.assign(exit.promise, { stdout, stderr, nodeChildProcess: raw })
}

function install(dir: string, name: string) {
  const path = join(dir, 'node_modules', name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(path, 'cordis.patch.yml'), '[]\n')
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, [name]: '1' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

it('anchors relative package specs without rewriting registry specs', () => {
  expect(anchorPathSpec('.', '/workspace')).toBe(resolve('/workspace'))
  expect(anchorPathSpec('file:../plugin', '/workspace/project')).toBe(`file:${resolve('/workspace/plugin')}`)
  expect(anchorPathSpec('package@1', '/workspace')).toBe('package@1')
})

it('activates newly installed bundles and leaves retained disabled dependencies disabled', async () => {
  const { dir, context } = fixture()
  install(dir, 'disabled')
  command.run.mockImplementationOnce(() => result(0, 'installed', () =>{  install(dir, 'new-bundle') }))
  expect(await runPluginCommand(context, ['add', 'new-bundle'], { execution: 'service', outputBytes: 100 })).toMatchObject({ exitCode: 0 })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['new-bundle'])
  command.run.mockImplementationOnce(() => result(0, 'updated'))
  await runPluginCommand(context, ['update'], { execution: 'service', outputBytes: 100 })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['new-bundle'])
})

it('can install without activation and bounds output while retaining the complete log', async () => {
  const { dir, context } = fixture()
  command.run.mockImplementationOnce(() => result(0, '0123456789', () =>{  install(dir, 'extra') }))
  const outcome = await runProfilePnpm(context, ['add', './extra'], { execution: 'service', outputBytes: 4, activateNewBundles: false })
  expect(outcome).toMatchObject({ exitCode: 0, output: '6789', truncated: true })
  expect(readFileSync(outcome.logPath, 'utf8')).toBe('0123456789')
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual([])
  expect(command.run.mock.calls[0]?.[1]).toEqual(['add', join(context.cwd, 'extra')])
})

it.each([runPluginCommand, runProfilePnpm])('installs into the supplied application profile directory with %s', async (run) => {
  const { home, dir: namedDir, context } = fixture()
  const dir = join(home, 'application', 'profile')
  initProfile(dir, [])
  command.run.mockImplementationOnce(() => result(0, 'installed', () => { install(dir, 'extra') }))
  const outcome = await run({ ...context, dir }, ['add', 'extra'], { execution: 'service', outputBytes: 100 })
  expect(outcome.exitCode).toBe(0)
  expect(command.run.mock.calls[0]?.[2]).toMatchObject({ cwd: dir })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['extra'])
  expect(readProfileManifest('test', namedDir).dependencies).not.toHaveProperty('extra')
  expect(readProfileManifest('test', namedDir).dsh?.profile?.bundles).toEqual([])
})

it('retains partial package-manager changes after failure without activating them', async () => {
  const { dir, context } = fixture()
  command.run.mockImplementationOnce(() => result(1, 'installation failed', () =>{  install(dir, 'partial') }))
  expect(await runProfilePnpm(context, ['add', 'partial'], { execution: 'service', outputBytes: 100 })).toMatchObject({ exitCode: 1 })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ partial: '1' })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual([])
})


it('initializes missing profiles under the same lock and reports initialization', async () => {
  const { home, context } = fixture()
  const messages: string[] = []
  command.run.mockImplementation(() => result(0, ''))
  for (const profile of ['custom', 'web']) {
    await runPluginCommand({ ...context, profile }, ['root'], {
      execution: 'service', outputBytes: 100, lockWaitMs: 1000, onOutput: (text) => { messages.push(text) },
    })
    expect(readProfileManifest('test', join(home, 'profiles', profile)).dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-base')
  }
  expect(messages.filter(text => text.includes('initialized profile'))).toHaveLength(2)
})

it('terminates a run that stopped printing and reports the silence bound', async () => {
  const { context } = fixture()
  command.run.mockImplementationOnce(() => silentChild('installing\n'))
  const outcome = await runProfilePnpm(context, ['add', 'silent'], { execution: 'service', outputBytes: 100, idleTimeoutMs: 20 })
  expect(outcome).toMatchObject({ exitCode: 1, timedOut: true })
  expect(outcome.output).toBe('installing\ndsh: pnpm printed nothing for 20ms and was terminated\n')
  expect(readFileSync(outcome.logPath, 'utf8')).toBe(outcome.output)
})

it('settles a run whose pipes stay open past the process exit', async () => {
  const { context } = fixture()
  const child = heldPipeChild('installed\n')
  command.run.mockImplementationOnce(() => child)
  const outcome = await runProfilePnpm(context, ['add', 'held'], {
    execution: 'service', outputBytes: 100, activateNewBundles: false,
  })
  expect(outcome).toMatchObject({ exitCode: 0 })
  expect(outcome.output).toBe('installed\ndsh: pnpm output was cut short after its process exited\n')
  // The pipes never ended on their own, so the run settled by cutting them here.
  expect(child.stdout.destroyed).toBe(true)
  expect(child.stderr.destroyed).toBe(true)
  expect(outcome.timedOut).toBeUndefined()
})

it('reports a terminated run that trapped the signal and exited zero', async () => {
  const { context } = fixture()
  command.run.mockImplementationOnce(() => silentChild('installing\n', 0))
  const outcome = await runProfilePnpm(context, ['add', 'trapped'], { execution: 'service', outputBytes: 100, idleTimeoutMs: 20 })
  // The independent facts stay separate: the signal was trapped, so the exit status is still zero.
  expect(outcome).toMatchObject({ exitCode: 0, timedOut: true })
  expect(outcome.output).toContain('printed nothing for 20ms and was terminated')
})

it('surfaces an output consumer failure the bounded drain cuts short', async () => {
  const { context } = fixture()
  command.run.mockImplementationOnce(() => heldPipeChild('installed\n'))
  await expect(runProfilePnpm(context, ['add', 'held'], {
    execution: 'service', outputBytes: 100, activateNewBundles: false,
    onOutput() { throw new Error('output destination closed') },
  })).rejects.toThrow('output destination closed')
})

it('reports a reading that fails with something other than an Error by its text', async () => {
  const { context } = fixture()
  const child = heldPipeChild('installed\n')
  command.run.mockImplementationOnce(() => child)
  await expect(runProfilePnpm(context, ['add', 'held'], {
    execution: 'service', outputBytes: 100, activateNewBundles: false,
    // A reading can reject with any value; its text is what the failure reports.
    onOutput() { throw 'pipe broke' },
  })).rejects.toThrow('pipe broke')
})

it('terminates a service run as a tree and leaves the CLI in the caller group', async () => {
  const { context } = fixture()
  command.run.mockImplementation(() => result(0, ''))
  await runProfilePnpm(context, ['add', 'tree'], { execution: 'service', outputBytes: 100, activateNewBundles: false })
  await runProfilePnpm(context, ['add', 'tree'], { execution: 'cli', outputBytes: 100, activateNewBundles: false })
  expect(command.run).toHaveBeenCalledWith(
    expect.anything(), expect.anything(), expect.objectContaining({ killDescendants: true }),
  )
  expect(command.run).toHaveBeenLastCalledWith(
    expect.anything(), expect.anything(), expect.objectContaining({ killDescendants: false }),
  )
})

it('retains built-in layers, removes deleted dependencies and warns about plain packages', async () => {
  const { context, dir } = fixture()
  install(dir, 'removed')
  const manifest = readProfileManifest('test', dir)
  manifest.dsh = { profile: { bundles: ['builtin', 'removed'] } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const messages: string[] = []
  command.run.mockImplementationOnce(() => result(0, '', () => {
    install(dir, 'plain')
    writeFileSync(join(dir, 'node_modules', 'plain', 'package.json'), '{"name":"plain"}')
    const after = readProfileManifest('test', dir)
    delete after.dependencies?.removed
    writeFileSync(join(dir, 'package.json'), JSON.stringify(after))
  }))
  await runPluginCommand(context, ['remove', 'removed'], { execution: 'service', outputBytes: 100, onOutput: (text) => { messages.push(text) } })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['builtin'])
  expect(messages.join('')).toContain('plain dependency')
})

it('preserves a package-manager selected new bundle without adding it twice', async () => {
  const { context, dir } = fixture()
  writeFileSync(join(dir, 'package.json'), '{}')
  command.run.mockImplementationOnce(() => result(0, '', () => {
    install(dir, 'new')
    const manifest = readProfileManifest('test', dir)
    manifest.dsh = { profile: { bundles: ['new'] } }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  }))
  await runProfilePnpm(context, ['add', 'new'], { execution: 'service', outputBytes: 100 })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['new'])
})

it.each([
  { code: 'ENOENT', shortMessage: 'pnpm not found', expected: 127 },
  { code: 'EACCES', shortMessage: undefined, expected: 1 },
])('reports launch failures with a complete log: $code', async ({ code, shortMessage, expected }) => {
  const { context } = fixture()
  command.run.mockImplementationOnce(() => result(undefined, '', () => {}, { code, ...shortMessage === undefined ? {} : { shortMessage } }))
  const outcome = await runProfilePnpm(context, ['root'], { execution: 'service', outputBytes: 4, signal: new AbortController().signal })
  expect(outcome.exitCode).toBe(expected)
  expect(outcome.truncated).toBe(true)
  expect(readFileSync(outcome.logPath, 'utf8')).toBe(shortMessage ?? 'pnpm failed')
})

it('cancels and settles package output when the output consumer fails', async () => {
  const { context } = fixture()
  let cancellation: AbortSignal | undefined
  command.run.mockImplementationOnce((_name, _args, options) => {
    cancellation = (options as { cancelSignal: AbortSignal }).cancelSignal
    const child = result(0, 'text')
    child.stdout.setEncoding('utf8')
    return child
  })
  await expect(runProfilePnpm(context, ['root'], {
    execution: 'service', outputBytes: 100, onOutput() { throw new Error('output destination closed') },
  })).rejects.toThrow('output destination closed')
  expect(cancellation?.aborted).toBe(true)
})

it('preserves an unexpected subprocess rejection after both streams settle', async () => {
  const { context } = fixture()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdout.end()
  stderr.end()
  command.run.mockImplementationOnce(() => Object.assign(Promise.reject(new Error('subprocess failed')), {
    stdout, stderr, nodeChildProcess: new EventEmitter(),
  }))
  await expect(runProfilePnpm(context, ['root'], { execution: 'service', outputBytes: 100 })).rejects.toThrow('subprocess failed')
})


it('handles manifests without dependency or bundle selections', async () => {
  const { context, dir } = fixture()
  command.run.mockImplementationOnce(() => result(0, '', () => { writeFileSync(join(dir, 'package.json'), '{}') }))
  expect(await runProfilePnpm(context, ['root'], { execution: 'service', outputBytes: 100 })).toMatchObject({ exitCode: 0 })
})

it.each(['cli', 'service'] as const)('uses the %s environment and interaction policy', async (execution) => {
  const { context } = fixture()
  const names = ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'DEEPSEEK_API_KEY']
  const originals = names.map(name => process.env[name])
  onTestFinished(() => {
    names.forEach((name, index) => {
      const original = originals[index]
      if (original === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = original
    })
  })
  for (const name of names) process.env[name] = 'fixture-credential'
  command.run.mockImplementationOnce(() => result(0, ''))
  await runPluginCommand(context, ['approve-builds'], { execution, outputBytes: 100 })
  const options = command.run.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv; stdin: string; stdout: string; stderr: string }
  for (const name of names) expect(options.env[name]).toBe(execution === 'cli' ? 'fixture-credential' : undefined)
  expect(options.stdin).toBe(execution === 'cli' ? 'inherit' : 'ignore')
  expect(options.stdout).toBe(execution === 'cli' ? 'inherit' : 'pipe')
  expect(options.stderr).toBe(execution === 'cli' ? 'inherit' : 'pipe')
})

it('settles inherited CLI descriptors without requiring captured streams', async () => {
  const { context } = fixture()
  command.run.mockImplementationOnce(() => Object.assign(
    Promise.resolve({ exitCode: 0, failed: false }), { stdout: null, stderr: null, nodeChildProcess: new EventEmitter() },
  ))
  expect(await runPluginCommand(context, ['approve-builds'], { execution: 'cli', outputBytes: 100 })).toMatchObject({ exitCode: 0, output: '' })
})

it('reads the registry pnpm\'s own configuration names in the profile, and answers null for anything but a URL', async () => {
  const { dir } = fixture()
  const answer = (value: object) => command.run.mockResolvedValueOnce(value as never)
  answer({ exitCode: 0, stdout: 'https://registry.npmmirror.com/\n', stderr: '' })
  expect(await readProfileRegistry(dir, { timeoutMs: 5 })).toBe('https://registry.npmmirror.com/')
  expect(command.run).toHaveBeenLastCalledWith('pnpm', ['config', 'get', 'registry'], expect.objectContaining({ cwd: dir, timeout: 5, reject: false, stdin: 'ignore' }))
  // Output pnpm prefixes with a notice keeps its last line; a failed or empty answer, or one that is no URL, reads as unknown.
  answer({ exitCode: 0, stdout: 'WARN  something\nhttps://npm.corp.example/', stderr: '' })
  expect(await readProfileRegistry(dir, { command: '/app/pnpm', args: ['--x'], timeoutMs: 5 })).toBe('https://npm.corp.example/')
  expect((command.run.mock.lastCall as unknown[]).slice(0, 2)).toEqual(['/app/pnpm', ['--x', 'config', 'get', 'registry']])
  answer({ exitCode: 1, stdout: '', stderr: 'ERR' })
  expect(await readProfileRegistry(dir, { timeoutMs: 5 })).toBeNull()
  answer({ exitCode: 0, stdout: 'undefined\n', stderr: '' })
  expect(await readProfileRegistry(dir, { timeoutMs: 5 })).toBeNull()
  answer({ exitCode: 0, stdout: '', stderr: '' })
  expect(await readProfileRegistry(dir, { timeoutMs: 5 })).toBeNull()
})

it('asks the registry through pnpm view in the profile directory, without pnpm\'s own retries, and reports how the lookup ended', async () => {
  const { dir } = fixture()
  const answer = (value: object) => command.run.mockResolvedValueOnce(value as never)
  answer({ exitCode: 0, stdout: '{"name":"x"}', stderr: '', timedOut: false, isCanceled: false })
  expect(await viewProfilePackage(dir, 'x@^1', { timeoutMs: 5 })).toEqual({ exitCode: 0, stdout: '{"name":"x"}', stderr: '', timedOut: false })
  expect(command.run).toHaveBeenLastCalledWith('pnpm', ['view', 'x@^1', 'name', 'version', 'description', 'dsh', '--json', '--config.fetch-retries=0'],
    expect.objectContaining({ cwd: dir, timeout: 5, reject: false, stdin: 'ignore' }))
  expect((command.run.mock.lastCall as unknown[])[2]).not.toHaveProperty('cancelSignal')
  // A registry asked by URL goes on the command line; null leaves the choice to pnpm's own configuration.
  answer({ exitCode: 0, stdout: '{"name":"x"}', stderr: '', timedOut: false, isCanceled: false })
  await viewProfilePackage(dir, 'x', { timeoutMs: 5, registry: 'https://registry.npmmirror.com/' })
  expect((command.run.mock.lastCall as unknown[])[1]).toEqual(['view', 'x', 'name', 'version', 'description', 'dsh', '--json', '--registry=https://registry.npmmirror.com/', '--config.fetch-retries=0'])
  answer({ exitCode: 0, stdout: '{"name":"x"}', stderr: '', timedOut: false, isCanceled: false })
  await viewProfilePackage(dir, 'x', { timeoutMs: 5, registry: null })
  expect((command.run.mock.lastCall as unknown[])[1]).toEqual(['view', 'x', 'name', 'version', 'description', 'dsh', '--json', '--config.fetch-retries=0'])
  const signal = AbortSignal.abort()
  answer({ exitCode: undefined, stdout: '', stderr: '', timedOut: true, isCanceled: false })
  expect(await viewProfilePackage(dir, 'x', { timeoutMs: 5, signal })).toEqual({ exitCode: null, stdout: '', stderr: '', timedOut: true })
  expect((command.run.mock.lastCall as unknown[])[2]).toMatchObject({ cancelSignal: signal })
  answer({ exitCode: undefined, stdout: '', stderr: '', timedOut: false, isCanceled: true })
  expect(await viewProfilePackage(dir, 'x', { command: 'node', timeoutMs: 5 })).toEqual({ exitCode: null, stdout: '', stderr: '', timedOut: false })
  expect((command.run.mock.lastCall as unknown[])[0]).toBe('node')
  answer({ exitCode: undefined, stdout: '', stderr: '', timedOut: false, isCanceled: false, code: 'ENOENT', shortMessage: 'spawn pnpm ENOENT' })
  const missing = await viewProfilePackage(dir, 'x', { timeoutMs: 5 })
  expect(missing).toMatchObject({ exitCode: null, timedOut: false })
  expect(missing.cause).toMatchObject({ message: 'spawn pnpm ENOENT', code: 'ENOENT' })
})

it('uses application-owned executable arguments and environment for package operations and inspection', async () => {
  const { dir, context } = fixture()
  const runtime = { command: '/app/electron', args: ['--expose-internals', '/app/pnpm.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/app/bin' } }
  command.run.mockImplementationOnce(() => result(0, ''))
  await runProfilePnpm(context, ['add', './extra'], { ...runtime, execution: 'service', outputBytes: 100, activateNewBundles: false })
  expect(command.run).toHaveBeenLastCalledWith(runtime.command, [...runtime.args, 'add', resolve(context.cwd, 'extra')],
    expect.objectContaining({ env: expect.objectContaining(runtime.env) as unknown }))
  command.run.mockResolvedValueOnce(Object.assign({ exitCode: 0, failed: false }, { stdout: '{}', stderr: '', timedOut: false }))
  await viewProfilePackage(dir, 'example', { ...runtime, timeoutMs: 1000 })
  expect(command.run).toHaveBeenLastCalledWith(runtime.command,
    [...runtime.args, 'view', 'example', 'name', 'version', 'description', 'dsh', '--json', '--config.fetch-retries=0'],
    expect.objectContaining({ env: expect.objectContaining(runtime.env) as unknown }))
})
