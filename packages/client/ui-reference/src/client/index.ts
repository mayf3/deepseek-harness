/**
 * Unified Web `@` reference source. File and session discovery run through
 * cancellable Host RPCs in parallel with deterministic ordering and labels.
 *
 * @module @deepseek-ai/dsh-client-ui-reference/client
 */
import type { ConnectionHandle, FileReferenceItem, SessionReferenceItem } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ClientSessionContext, InputTriggerServiceContract, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'

const FILE_SECTION = '文件与文件夹'
const SESSION_SECTION = 'Session 对话'

/** Required services: the slash registry and Host connection. */
export const inject = ['inputTriggers', 'connection']

/**
 * Register the combined `@file` / `@session` source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const references = (ctx.get('connection') as ConnectionHandle).api.references
  const source: InputTriggerSource = {
    trigger: '@',
    name: 'reference',
    async candidates(session: ClientSessionContext, { query, quoted, signal }) {
      const files = references.files({ sessionId: session.sessionId, query }, signal).then(
        response => response.result.ok ? response.result.value.items : [],
        () => [],
      )
      const sessions = quoted === true
        ? Promise.resolve([] as SessionReferenceItem[])
        : references.sessions({ sessionId: session.sessionId, query }, signal).then(
          response => response.result.ok ? response.result.value.items : [],
          () => [],
        )
      const [fileItems, sessionItems] = await Promise.all([files, sessions])
      if (signal.aborted) return []
      return [
        ...fileItems.flatMap(candidate => fileCandidate(candidate, quoted === true)),
        ...sessionItems.map(sessionCandidate),
      ]
    },
    onPick({ candidate }) {
      const value = parseCandidate(candidate.value)
      if (value?.kind === 'file') {
        return {
          text: value.mention + (value.fileKind === 'file' ? ' ' : ''),
          ...value.fileKind === 'directory' ? { continue: true } : {},
        }
      }
      if (value?.kind === 'session') {
        return {
          insert: {
            source: 'reference',
            ref: value.mention,
            label: `@${value.label}`,
            clipboardText: value.mention,
          },
        }
      }
      return undefined
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(source), 'ui-reference: @ source')
}

type ReferenceCandidateValue =
  | { kind: 'file'; fileKind: FileReferenceItem['kind']; mention: string }
  | { kind: 'session'; label: string; mention: string }

function fileCandidate(candidate: FileReferenceItem, preserveQuote: boolean) {
  const mention = formatFileMention(candidate, preserveQuote)
  if (mention === undefined) return []
  const name = candidate.path.slice(candidate.path.lastIndexOf('/') + 1)
  const directory = candidate.kind === 'directory'
  const value: ReferenceCandidateValue = {
    kind: 'file',
    fileKind: candidate.kind,
    mention,
  }
  return [{
    name: `${directory ? 'Folder' : 'File'} · ${name}${directory ? '/' : ''}`,
    description: candidate.path,
    section: FILE_SECTION,
    value: JSON.stringify(value),
  }]
}

function sessionCandidate(candidate: SessionReferenceItem) {
  const location = candidate.cwd ?? '(no cwd)'
  const description = `${candidate.label === candidate.sessionId ? '' : `${candidate.sessionId} · `}${location} · ${new Date(candidate.createdAt).toISOString()}`
  const value: ReferenceCandidateValue = {
    kind: 'session',
    label: candidate.label,
    mention: candidate.mention,
  }
  return {
    name: `Session · ${candidate.label}`,
    description,
    section: SESSION_SECTION,
    value: JSON.stringify(value),
  }
}

function parseCandidate(value: string | undefined): ReferenceCandidateValue | undefined {
  if (value === undefined) return undefined
  return JSON.parse(value) as ReferenceCandidateValue
}
