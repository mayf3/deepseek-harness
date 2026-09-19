/** One-time contributor command to publish V4 successors through JSONL persistence. */

import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { appendFileSync, closeSync, mkdtempSync, openSync, realpathSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { availableParallelism, homedir, tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { inspect, parseArgs } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { encodeSegment, generationLogFilename, parseGenerationLogFilename, type JsonlCompression } from '../packages/session/session-persistence-jsonl/src/format.ts'
import { JsonlGenerationSourceChangedError } from '../packages/session/session-persistence-jsonl/src/generation.ts'

const usage = `Usage: pnpm run migrate:sessions-to-v4 [--sessions-dir PATH] [--jobs N]

Publish V4 successors beside unchanged historical Session generations.
Defaults to ~/.dsh/sessions. Already-V4 Sessions are opened read-only.
No model or API key is used. Failures do not stop subsequent Sessions.
The complete report is saved in a private OS temporary directory.

Options:
  --sessions-dir PATH  Session root to migrate
  --jobs N             Concurrent Sessions, positive integer (default: CPU count capped at 16)
  --help              Show this help
`

interface Candidate {
  readonly directory: string
  readonly source?: { readonly filename: string; readonly version: number; readonly compression: JsonlCompression; readonly bytes: number }
  readonly error?: unknown
}

async function inspectDirectory(directory: string): Promise<Candidate> {
  try {
    const entries = await readdir(directory)
    const generations = entries.flatMap(filename => (['none', 'zstd'] as const).flatMap((compression) => {
      const version = parseGenerationLogFilename(filename, compression)
      return version === undefined ? [] : [{ filename, version, compression }]
    })).sort((left, right) => right.version - left.version || left.filename.localeCompare(right.filename))
    const selected = generations[0]
    if (selected === undefined) return { directory }
    const metadata = await stat(join(directory, selected.filename))
    return { directory, source: { ...selected, bytes: metadata.size } }
  } catch (error: unknown) {
    return { directory, error }
  }
}

async function discover(root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  const projects = await readdir(root, { withFileTypes: true })
  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(root, project.name)
    if (project.isSymbolicLink()) {
      candidates.push({ directory, error: new Error('project symbolic links are not traversed') })
      continue
    }
    if (!project.isDirectory()) {
      if (project.name.endsWith('.jsonl') || project.name.endsWith('.jsonl.zstd')) {
        candidates.push({ directory, error: new Error('unsupported flat-file layout; expected project/session/generation') })
      }
      continue
    }
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) candidates.push({ directory: path, error: new Error('Session symbolic links are not traversed') })
        else if (entry.isDirectory()) candidates.push(await inspectDirectory(path))
        else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) {
          candidates.push({ directory: path, error: new Error('unsupported flat-file layout; expected project/session/generation') })
        }
      }
    } catch (error: unknown) {
      candidates.push({ directory, error })
    }
  }
  return candidates
}

function directoryId(directory: string): SessionId {
  const segment = basename(directory)
  const id = segment.replace(/~([0-9A-F]{4})/gu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  if (encodeSegment(id) !== segment) throw new Error(`noncanonical Session directory name ${JSON.stringify(segment)}`)
  return SessionId(id)
}

/**
 * Run bounded Session jobs, then retry deferred inputs once after every initial job settles.
 * @param count - Number of discovered inputs.
 * @param jobs - Positive number of concurrent initial operations.
 * @param visit - Attempt an input; return true to defer its first attempt until the serial retry pass.
 * @returns Completion after all active operations have settled, including on unexpected rejection.
 */
export async function runMigrationJobs(
  count: number,
  jobs: number,
  visit: (index: number, retry: boolean) => Promise<boolean>,
): Promise<void> {
  let next = 0
  const deferred: number[] = []
  const workers = Array.from({ length: Math.min(jobs, count) }, async () => {
    while (next < count) {
      const index = next++
      if (await visit(index, false)) deferred.push(index)
    }
  })
  const results = await Promise.allSettled(workers)
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  for (const index of deferred.sort((a, b) => a - b)) await visit(index, true)
}

async function migrate(root: string, jobs: number): Promise<number> {
  const logPath = join(mkdtempSync(join(tmpdir(), 'dsh-migrate-v4-')), 'migration.log')
  const log = openSync(logPath, 'wx', 0o600)
  const write = (line: string): void => {
    appendFileSync(log, `${line}\n`)
    console.log(line)
  }
  const failures: { directory: string; message: string }[] = []
  const fail = (directory: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    failures.push({ directory, message })
    write(`ERROR ${JSON.stringify(directory)}: ${message}`)
    appendFileSync(log, `${inspect(error, { depth: null, colors: false })}\n`)
  }
  let converted = 0
  let current = 0
  let skipped = 0
  try {
    write(`Session migration to V4 started ${new Date().toISOString()}`)
    write(`Root: ${root}`)
    write(`Session jobs: ${jobs}`)
    write(`Node: ${process.version}; platform: ${process.platform}/${process.arch}`)
    write(`Git HEAD: ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }).trim()}`)
    write(`Full log: ${logPath}`)
    assert.equal(SESSION_FORMAT_VERSION, 4, 'this one-time command requires a V4 Session writer')
    assert.equal(sessionFormatCatalog.currentVersion, 4, 'this one-time command requires a V4 format catalog')
    const candidates = await discover(root)
    write(`Discovered ${candidates.length} Session directories or invalid layout entries.`)
    const compression = candidates.find(candidate => candidate.source !== undefined)?.source?.compression ?? 'zstd'
    const ctx = new Context()
    try {
      await ctx.plugin(JsonlSessionPersistence, { root, compression })
      let completed = 0
      await runMigrationJobs(candidates.length, jobs, async (index, retry) => {
        const candidate = candidates[index]
        assert(candidate !== undefined, 'migration job index must name a discovered input')
        const { directory, source } = candidate
        const label = `[${index + 1}/${candidates.length}] ${JSON.stringify(relative(root, directory))}`
        const started = performance.now()
        write(`${label} ${retry ? 'RETRY' : 'START'} ${source === undefined ? 'inspect entry' : `${source.filename} (V${source.version}, ${source.bytes} bytes)`}`)
        const finish = (status: string): void => {
          completed += 1
          write(`${label} ${status}; completed=${completed}/${candidates.length}`)
        }
        try {
          if (candidate.error !== undefined) {
            throw candidate.error instanceof Error ? candidate.error : new Error('directory inspection failed', { cause: candidate.error })
          }
          if (source === undefined) {
            skipped += 1
            finish('SKIPPED: no canonical Session generation')
            return false
          }
          const id = directoryId(directory)
          const handle = await ctx.sessionPersistence.open(id, source.version === 4 ? 'read' : 'write')
          await handle.close()
          if (source.version === 4) current += 1
          else converted += 1
          finish(`${source.version === 4 ? 'already V4 (opened successfully)' : `V${source.version} -> V4: ${generationLogFilename(4, source.compression)}`} (${((performance.now() - started) / 1000).toFixed(2)}s)`)
        } catch (error: unknown) {
          if (!retry && error instanceof JsonlGenerationSourceChangedError) {
            write(`${label} DEFERRED: ${error.message}; retry once after initial jobs finish`)
            appendFileSync(log, `${inspect(error, { depth: null, colors: false })}\n`)
            return true
          }
          finish(`FAILED (${((performance.now() - started) / 1000).toFixed(2)}s)`)
          fail(source === undefined ? directory : join(directory, source.filename), error)
        }
        return false
      })
    } finally {
      await ctx.fiber.dispose()
    }
  } catch (error: unknown) {
    fail(root, error)
  } finally {
    write(`Summary: converted=${converted}, already-V4=${current}, failed=${failures.length}, skipped=${skipped}`)
    if (failures.length > 0) {
      write('Failures (full stacks and causes are in the log):')
      for (const failure of failures) write(`- ${JSON.stringify(failure.directory)}: ${failure.message}`)
    }
    write(`Full log: ${logPath}`)
    closeSync(log)
  }
  return failures.length > 0 ? 1 : 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  try {
    const { values } = parseArgs({ options: { 'sessions-dir': { type: 'string' }, jobs: { type: 'string' }, help: { type: 'boolean' } }, strict: true })
    if (values.help) console.log(usage)
    else {
      const jobs = values.jobs === undefined ? Math.min(availableParallelism(), 16) : Number(values.jobs)
      if (!Number.isSafeInteger(jobs) || jobs < 1 || (values.jobs !== undefined && !/^[1-9]\d*$/u.test(values.jobs))) {
        throw new Error('--jobs must be a positive safe integer')
      }
      process.exitCode = await migrate(resolve(values['sessions-dir'] ?? join(homedir(), '.dsh', 'sessions')), jobs)
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage)
    process.exitCode = 1
  }
}
