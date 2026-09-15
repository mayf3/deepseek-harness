/** Deterministic in-memory PTY backend for transcript snapshots. */

import { PassThrough } from 'node:stream'

class SnapshotSession {
  motd = ''
  statusValue = { kind: 'running' }
  scrollback = 'dsh> '
  startupWaits = 0

  constructor(terminal) {
    this.terminal = terminal
  }

  startSend(request) {
    // Prompt output precedes the startup send that observes stdin readiness.
    const startup = this.startupWaits < 2
    const viewport = startup
      ? (this.startupWaits++ === 0 ? 'dsh> ' : '')
      : `${request.text}\nPTY_OK\ndsh> `
    if (!startup) this.scrollback += viewport
    const result = {
      viewport,
      waitReason: this.startupWaits === 1 ? 'inferred_idle' : 'stdin_read',
      sessionStatus: this.statusValue,
      truncated: false,
    }
    let consumed = false
    return {
      done: Promise.resolve(result),
      readOutput: () => {
        if (consumed) return { delta: '', truncated: false }
        consumed = true
        return { delta: viewport, truncated: false }
      },
      cancel: () => false,
    }
  }

  read(request) {
    const lines = this.scrollback.split('\n')
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    const end = lines.length - offset
    const start = Math.max(0, end - count)
    const text = lines.slice(start, end).join('\n')
    return { text, totalLines: lines.length, lineBegin: offset, lineEnd: offset + text.split('\n').length, truncated: false }
  }

  signal() {
    return Promise.resolve({ delivered: true, targetPgid: 1 })
  }

  status() {
    return this.statusValue
  }

  close() {
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null }
    return this.terminal.terminate()
  }
}

/** Cordis plugin name. */
export const name = 'pty-snapshot-backend'
/** Terminal registry and startup policy services. */
export const inject = ['terminals', 'sandboxPolicy', 'sessionProjections']

/** Register the deterministic snapshot backend. */
export async function apply(ctx) {
  const { BashTerminalBackend } = await ctx.loader.import('@deepseek-ai/dsh-terminal-bash')
  ctx.terminals.registerBackend(new BashTerminalBackend(ctx, {
    backendType: 'shell', shellDialect: 'pwsh', shellPath: 'pwsh', shellArgs: [],
    rows: 40, cols: 160, scrollbackLines: 100, scrollbackMaxBytes: 32_768, maxReadBytes: 16_384,
    pollIntervalMs: 10, exactProbeAfterMs: 20, idleSilenceMs: 250, handoffGraceMs: 250,
    timeoutMs: 30_000, disposeGraceMs: 500,
  }, async () => {
    const output = new PassThrough()
    const outcome = Promise.withResolvers()
    return {
      pid: 1, output, done: outcome.promise,
      write: async () => {},
      inspectForeground: async () => ({ processGroupId: 1, inputWaiting: true }),
      signalForeground: async () => 1,
      async terminate() { output.end(); outcome.resolve({ exitCode: 0, signal: null }) },
    }
  }, terminal => new SnapshotSession(terminal)))
}
