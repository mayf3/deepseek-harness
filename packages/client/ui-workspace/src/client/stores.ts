/**
 * The workspace browser's viewing store: the session-list grouping mode,
 * persisted across reloads. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * register() receives the factory and the browser derives its PropsStore
 * share from the return type.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import { TAG_GROUP_PREFIX } from './tree.ts'

/** Browser-local order account for the hierarchy-free flat Session list. */
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'

/** Session-list grouping mode: workspace sections, tag sections, or one flat recency list. */
export type SessionGroupBy = 'workspace' | 'flat' | 'tag'
/** Session order: user-arranged only, or user-arranged plus activity promotion. */
export type SessionOrderBy = 'manual' | 'updated'

/** Browser-local organization metadata for one session row. */
export type SessionMeta = {
  /** Free-form labels; shown as tag sections in the tag view. */
  tags?: string[]
  /** Id of the session this one waits on (rendered nested under its parent). */
  parent?: string
  /** Manually set unread flag; cleared when the session is opened. */
  unread?: boolean
}

/** Workspace browser viewing state persisted across surface remounts and reloads. */
type WorkspaceViewState = {
  groupBy: SessionGroupBy
  orderBy: SessionOrderBy
  /** Explicit zero-or-five-session state keyed by Workspace group identity. */
  groupExpansion: Record<string, boolean>
  /** Shared editable order per Workspace group plus the browser-local flat-list account. */
  sessionOrderByAccount: Record<string, string[]>
  /** Last observed update timestamps per order account for one-time promotion events. */
  sessionUpdatedAtByAccount: Record<string, Record<string, number>>
  /** Session-id-keyed organization metadata (tags + waiting-on parent). */
  sessionMeta: Record<string, SessionMeta>
  /** Explicitly created tags with no session yet (empty tag sections stay visible). */
  knownTags: string[]
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type WorkspaceViewActions = {
  setGroupBy: (draft: WorkspaceViewState, mode: SessionGroupBy) => void
  setOrderBy: (draft: WorkspaceViewState, mode: SessionOrderBy) => void
  setGroupExpanded: (draft: WorkspaceViewState, key: string, expanded: boolean) => void
  retainAccountKeys: (draft: WorkspaceViewState, workspaceKeys: readonly string[]) => void
  syncSessionOrderAccount: (
    draft: WorkspaceViewState,
    accountKey: string,
    order: string[],
    updatedAt: Record<string, number>,
  ) => void
  setSessionOrder: (draft: WorkspaceViewState, accountKey: string, order: string[]) => void
  setSessionTags: (draft: WorkspaceViewState, sessionId: string, tags: string[]) => void
  setSessionParent: (draft: WorkspaceViewState, sessionId: string, parent: string | undefined) => void
  setSessionUnread: (draft: WorkspaceViewState, sessionId: string, unread: boolean) => void
  /** Delete a tag everywhere: strip it from sessions, knownTags, and the tag-group expansion key. */
  removeTag: (draft: WorkspaceViewState, tag: string) => void
  addKnownTag: (draft: WorkspaceViewState, tag: string) => void
}

/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore(): EngineStoreHandle<WorkspaceViewState, WorkspaceViewActions> {
  return defineStore({
    init: (): WorkspaceViewState => ({
      groupBy: 'workspace',
      orderBy: 'updated',
      groupExpansion: {},
      sessionOrderByAccount: {},
      sessionUpdatedAtByAccount: {},
      sessionMeta: {},
      knownTags: [],
    }),
    persist: 'dsh.workspace.view.v6',
    actions: {
      setGroupBy: (d, mode: SessionGroupBy) => { d.groupBy = mode },
      setOrderBy: (d, mode: SessionOrderBy) => { d.orderBy = mode },
      setGroupExpanded: (d, key: string, expanded: boolean) => { d.groupExpansion[key] = expanded },
      retainAccountKeys: (d, workspaceKeys: readonly string[]) => {
        const retained = new Set(workspaceKeys)
        // Tag-view sections are not Workspace accounts; keep their persisted
        // expansion state across Workspace changes (otherwise tag groups
        // reset to collapsed on every reload or Workspace mutation).
        const keep = (key: string) => retained.has(key) || key.startsWith(TAG_GROUP_PREFIX)
        d.groupExpansion = Object.fromEntries(
          Object.entries(d.groupExpansion).filter(([key]) => keep(key)),
        )
        d.sessionOrderByAccount = Object.fromEntries(
          Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)),
        )
        d.sessionUpdatedAtByAccount = Object.fromEntries(
          Object.entries(d.sessionUpdatedAtByAccount).filter(([key]) => retained.has(key)),
        )
      },
      syncSessionOrderAccount: (d, accountKey: string, order: string[], updatedAt: Record<string, number>) => {
        d.sessionOrderByAccount[accountKey] = order
        d.sessionUpdatedAtByAccount[accountKey] = updatedAt
      },
      setSessionOrder: (d, accountKey: string, order: string[]) => {
        d.sessionOrderByAccount[accountKey] = order
      },
      setSessionTags: (d, sessionId: string, tags: string[]) => {
        d.sessionMeta[sessionId] = { ...d.sessionMeta[sessionId], tags }
      },
      setSessionParent: (d, sessionId: string, parent: string | undefined) => {
        if (parent === undefined) {
          const { parent: _drop, ...rest } = d.sessionMeta[sessionId] ?? {}
          void _drop
          d.sessionMeta[sessionId] = rest
        } else {
          d.sessionMeta[sessionId] = { ...d.sessionMeta[sessionId], parent }
        }
      },
      setSessionUnread: (d, sessionId: string, unread: boolean) => {
        d.sessionMeta[sessionId] = { ...d.sessionMeta[sessionId], unread }
      },
      addKnownTag: (d, tag: string) => {
        if (!d.knownTags.includes(tag)) d.knownTags = [...d.knownTags, tag]
      },
      removeTag: (d, tag: string) => {
        d.knownTags = d.knownTags.filter(t => t !== tag)
        for (const [id, entry] of Object.entries(d.sessionMeta)) {
          if (entry.tags?.includes(tag) === true) {
            d.sessionMeta[id] = { ...entry, tags: entry.tags.filter(t => t !== tag) }
          }
        }
        d.groupExpansion = Object.fromEntries(
          Object.entries(d.groupExpansion).filter(([key]) => key !== TAG_GROUP_PREFIX + tag),
        )
      },
    },
  })
}
