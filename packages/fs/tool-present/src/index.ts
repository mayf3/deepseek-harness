/** Scoped tool that saves immutable file deliveries and records their owning Session. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PresentedFile } from './types.ts'

/** Stable Loader identity. */
export const name = 'tool-present'

/** Per-call snapshot limits. */
export interface Config {
  /** Inclusive per-file byte cap; at most 100 MiB. */
  maxFileBytes: number
  /** Maximum number of files in one call. */
  maxFiles: number
}

/** Validated snapshot limits. */
export const Config: z<Config> = z.object({
  maxFileBytes: z.number().default(100 * 1024 * 1024),
  maxFiles: z.number().default(8),
})

/** Services used by the scoped snapshot tool. */
export const inject = ['tools', 'fs', 'attachments', 'sessionProjections']

/**
 * Register present with durable file references in its tool result.
 * @param ctx - agent-scoped services.
 * @param config - per-file and per-call limits.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 1 || config.maxFileBytes > 100 * 1024 * 1024
    || !Number.isSafeInteger(config.maxFiles) || config.maxFiles < 1) {
    throw new Error('present requires positive integer limits; maxFileBytes must not exceed 100 MiB')
  }
  const pending = new WeakMap<ToolExecution, { session: Session; turn: number; files: PresentedFile[] }>()
  ctx.tools.register(defineTool({
    name: 'present',
    description: 'Deliver final files to the user. Saves a snapshot of each existing workspace file so it remains downloadable after edits or deletion. Create the files before calling this tool.',
    parameters: {
      files: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Path of an existing file inside the workspace.' },
            description: { type: 'string', description: 'Brief description for the user.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          turn: { type: 'integer', required: true },
          files: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true }, name: { type: 'string', required: true },
                attachmentId: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.files.map(file => `Presented ${file.path} (${file.bytes} bytes)`).join('\n') }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('present requires an agent Session')
      const boundary = ctx.sessionProjections.stateOf(exec.agent.session, 'turnBoundary')
      if (boundary === undefined || boundary.openTurnStartSeq === null) throw new Error('present requires an open turn')
      if (args.files.length === 0 || args.files.length > config.maxFiles) throw new Error(`present accepts 1 to ${config.maxFiles} files`)
      const cwd = exec.agent.session.header.cwd
      if (cwd === undefined) throw new Error('present requires a workspace')
      const options = { cwd, signal: exec.signal }
      const root = await ctx.fs.resolve('.', options)
      const admitted = []
      for (const file of args.files) {
        if (file.path.trim().length === 0) throw new Error('present requires a non-empty file path')
        const target = await ctx.fs.resolve(file.path, options)
        if (!ctx.fs.contains(root, target)) throw new Error(`Cannot present ${file.path}: outside the workspace`)
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new FsError(`Cannot present ${file.path}: file not found. Check the path, create the file if needed, and retry.`, 'FS_NOT_FOUND')
        if (info.type !== 'file') throw new Error(`Cannot present ${file.path}: not a regular file`)
        if (info.size !== undefined && info.size > config.maxFileBytes) throw new FsError(`Cannot present ${file.path}: file exceeds ${config.maxFileBytes} bytes`, 'FS_TOO_LARGE')
        admitted.push({ file, target, version: info.version })
      }
      const files = []
      for (const { file, target, version } of admitted) {
        const data = await ctx.fs.readBytes(target, exec.signal, config.maxFileBytes)
        const after = await ctx.fs.stat(target, exec.signal)
        if (after?.version !== version) throw new FsError(`Cannot present ${file.path}: file changed while reading; retry.`, 'FS_STALE_VERSION')
        exec.signal.throwIfAborted()
        const name = file.path.slice(Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\')) + 1)
        const ref = await ctx.attachments.saveFile({ data, name })
        files.push({ ...file, ...ref })
      }
      pending.set(exec, { session: exec.agent.session, turn: boundary.lastTurn, files })
      return { turn: boundary.lastTurn, files }
    },
  }))
  ctx.on('tools/result', (exec, result) => {
    const delivery = pending.get(exec)
    pending.delete(exec)
    if (delivery === undefined || result.isError) return
    const { session, turn, files } = delivery
    session.append('deliverables/presented', {
      turn, callId: exec.callId, files,
    })
  })
}
