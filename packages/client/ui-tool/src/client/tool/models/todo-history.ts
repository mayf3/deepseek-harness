/** Indexed recorded todo predecessors for root and nested Tool calls. */
import type {} from '@deepseek-ai/dsh-tools/types'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode, TodoItem,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The durable list preceding one Tool invocation; absent before the first loaded write. */
export interface TodoBaseline {
  readonly todos: readonly TodoItem[] | undefined
}

/** Session-owned call lookup, read only through the target's observable snapshot. */
export interface TodoHistory {
  /** @param callId - Root or nested call identity. @returns its recorded predecessor, when the start is loaded. */
  get(callId: string): TodoBaseline | undefined
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Recorded todo lists preceding each loaded todo call. */
    'tool-todo-history': TodoHistory
  }
}

/** Durable writes are indexed independently of Tool success receipts. */
export const todoWriteDefinition: ConversationNodeDefinition<readonly TodoItem[]> = {
  kind: 'tool-todo-write',
  match: event => event.type === 'todo/write' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'todo/write') throw new Error('tool-todo-write requires todo/write')
    return match.event.data.todos
  },
  update: context => context.state,
  publication: () => 'none',
}

/** Invocation predecessors are repaired by the assembler when older history arrives. */
export const todoCallDefinition: ConversationNodeDefinition<TodoBaseline> = {
  kind: 'tool-todo-call',
  target: 'tool-todo-history',
  match: (event) => {
    if (event.type === 'tool/call' && event.data.name === 'todo_write') {
      return { id: String(event.data.callId), role: 'start' }
    }
    if (event.type === 'tool/ptc-dispatch-start' && event.data.name === 'todo_write') {
      return { id: String(event.data.subCallId), role: 'start' }
    }
    return null
  },
  start: (_context, _match, reader) => ({ todos: reader.previous<readonly TodoItem[]>('tool-todo-write')?.state }),
  update: context => context.state,
  buildViewNode: context => context.state === undefined ? null : {
    key: context.key, kind: context.kind, id: context.id, target: 'tool-todo-history', data: context.state,
  },
}

interface TodoHistoryNode extends ConversationViewNode {
  readonly data: TodoBaseline
}

/** Incremental target whose publication invalidates keyed reads without copying older calls. */
export const todoHistoryView: ConversationViewDefinition<TodoHistoryNode, TodoHistory> = {
  target: 'tool-todo-history',
  create: () => {
    let calls = new Map<string, TodoBaseline>()
    const snapshot = (source: ReadonlyMap<string, TodoBaseline>): TodoHistory => ({ get: callId => source.get(callId) })
    let current: TodoHistory = snapshot(calls)
    const publish = (next: Map<string, TodoBaseline>): TodoHistory => {
      calls = next
      current = snapshot(next)
      return current
    }
    return {
      empty: current,
      replace: ({ nodes }) => publish(new Map(nodes.map(node => [node.id, node.data]))),
      apply: ({ upserts }) => {
        if (upserts.length === 0) return current
        const next = new Map(calls)
        for (const node of upserts) next.set(node.id, node.data)
        return publish(next)
      },
    }
  },
}

/**
 * Install the recorded-write index and call predecessor target.
 * @param ctx - Tool presentation plugin context.
 */
export function registerTodoHistory(ctx: Context): void {
  ctx.uiConversation.events.register(todoWriteDefinition)
  ctx.uiConversation.events.register(todoCallDefinition)
  ctx.uiConversation.views.register(todoHistoryView)
}
