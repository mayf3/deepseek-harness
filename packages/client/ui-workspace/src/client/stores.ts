import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import { GROUP_SECTION_PREFIX, UNASSIGNED_GROUP_KEY } from './group-keys.ts'

/** Browser-local order account for the hierarchy-free flat Session list. */
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'

const PERSIST_KEY = 'dsh.workspace.view.v7'
const LEGACY_PERSIST_KEY = 'dsh.workspace.view.v6'
const LEGACY_GROUP_PREFIX = 'tag:'
const LEGACY_UNASSIGNED_KEY = 'tag:\u0000untagged'

/** Session-list grouping mode: workspace sections, user groups, or one flat list. */
export type SessionGroupBy = 'workspace' | 'flat' | 'group'
/** Session order: user-arranged only, or user-arranged plus activity promotion. */
export type SessionOrderBy = 'manual' | 'updated'

/** Browser-local organization metadata for one session row. */
export type SessionMeta = {
  /** Exclusive user-managed group; absent means Unassigned. */
  group?: string
  /** Id of the session this one waits on (rendered nested under its parent). */
  parent?: string
  /** Manually set unread flag; cleared when the session is opened. */
  unread?: boolean
}

/** Workspace browser viewing state persisted across surface remounts and reloads. */
type WorkspaceViewState = {
  groupBy: SessionGroupBy
  orderBy: SessionOrderBy
  /** Unread-only filter: rows without the unread flag are hidden. */
  unreadOnly: boolean
  /** Explicit expansion state keyed by Workspace/group identity. */
  groupExpansion: Record<string, boolean>
  /** Shared editable order per Workspace/group plus the flat-list account. */
  sessionOrderByAccount: Record<string, string[]>
  /** Last observed timestamps per order account for one-time activity promotion. */
  sessionUpdatedAtByAccount: Record<string, Record<string, number>>
  /** Session-id-keyed organization metadata. */
  sessionMeta: Record<string, SessionMeta>
  /** Explicitly created groups with no session yet (empty columns stay visible). */
  knownGroups: string[]
}

type WorkspaceViewActions = {
  setGroupBy: (draft: WorkspaceViewState, mode: SessionGroupBy) => void
  setOrderBy: (draft: WorkspaceViewState, mode: SessionOrderBy) => void
  setUnreadOnly: (draft: WorkspaceViewState, unreadOnly: boolean) => void
  setGroupExpanded: (draft: WorkspaceViewState, key: string, expanded: boolean) => void
  retainAccountKeys: (draft: WorkspaceViewState, workspaceKeys: readonly string[]) => void
  syncSessionOrderAccount: (
    draft: WorkspaceViewState,
    accountKey: string,
    order: string[],
    updatedAt: Record<string, number>,
  ) => void
  setSessionOrder: (draft: WorkspaceViewState, accountKey: string, order: string[]) => void
  setSessionGroup: (draft: WorkspaceViewState, sessionId: string, group: string | undefined) => void
  setSessionParent: (draft: WorkspaceViewState, sessionId: string, parent: string | undefined) => void
  setSessionUnread: (draft: WorkspaceViewState, sessionId: string, unread: boolean) => void
  removeGroup: (draft: WorkspaceViewState, group: string) => void
  addKnownGroup: (draft: WorkspaceViewState, group: string) => void
}

/**
 * Normalize a user group name for storage and matching.
 * @param value - raw group name.
 * @returns trimmed, NUL-free, 32-character name; undefined when empty.
 */
export function normalizeGroupName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replaceAll('\0', '').trim().slice(0, 32)
  return normalized === '' ? undefined : normalized
}

function defaultState(): WorkspaceViewState {
  return {
    groupBy: 'workspace',
    orderBy: 'updated',
    unreadOnly: false,
    groupExpansion: {},
    sessionOrderByAccount: {},
    sessionUpdatedAtByAccount: {},
    sessionMeta: {},
    knownGroups: [],
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringOrders(value: unknown): Record<string, string[]> {
  const source = record(value)
  if (source === undefined) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([key, entry]) => {
    if (!Array.isArray(entry)) return []
    return [[key, entry.filter((id): id is string => typeof id === 'string')]]
  }))
}

function timestampOrders(value: unknown): Record<string, Record<string, number>> {
  const source = record(value)
  if (source === undefined) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([key, entry]) => {
    const timestamps = record(entry)
    if (timestamps === undefined) return []
    return [[key, Object.fromEntries(Object.entries(timestamps).filter((pair): pair is [string, number] =>
      typeof pair[1] === 'number' && Number.isFinite(pair[1])))]]
  }))
}

function migrateExpansion(value: unknown): Record<string, boolean> {
  const source = record(value)
  if (source === undefined) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([key, expanded]) => {
    if (typeof expanded !== 'boolean') return []
    if (key === LEGACY_UNASSIGNED_KEY) return [[UNASSIGNED_GROUP_KEY, expanded]]
    if (!key.startsWith(LEGACY_GROUP_PREFIX)) return [[key, expanded]]
    const group = normalizeGroupName(key.slice(LEGACY_GROUP_PREFIX.length))
    return group === undefined ? [] : [[GROUP_SECTION_PREFIX + group, expanded]]
  }))
}

function migrateSessionMeta(value: unknown): Record<string, SessionMeta> {
  const source = record(value)
  if (source === undefined) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([id, entry]) => {
    const legacy = record(entry)
    if (legacy === undefined) return []
    const tags = Array.isArray(legacy.tags) ? legacy.tags : []
    const group = tags.map(normalizeGroupName).find((item): item is string => item !== undefined)
    const meta: SessionMeta = {
      ...(group === undefined ? {} : { group }),
      ...(typeof legacy.parent === 'string' ? { parent: legacy.parent } : {}),
      ...(typeof legacy.unread === 'boolean' ? { unread: legacy.unread } : {}),
    }
    return [[id, meta]]
  }))
}

/** Write one idempotent v6→v7 migration before persistence rehydrates v7. */
function migrateLegacyState(): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (localStorage.getItem(PERSIST_KEY) !== null) return
    const raw = localStorage.getItem(LEGACY_PERSIST_KEY)
    if (raw === null) return
    const legacy = record(JSON.parse(raw))
    if (legacy === undefined) return
    const known = Array.isArray(legacy.knownTags) ? legacy.knownTags : []
    const knownGroups = [...new Set(known.map(normalizeGroupName).filter((item): item is string => item !== undefined))]
    const migrated: WorkspaceViewState = {
      groupBy: legacy.groupBy === 'tag' ? 'group'
        : legacy.groupBy === 'flat' ? 'flat'
          : 'workspace',
      orderBy: legacy.orderBy === 'manual' ? 'manual' : 'updated',
      unreadOnly: legacy.unreadOnly === true,
      groupExpansion: migrateExpansion(legacy.groupExpansion),
      sessionOrderByAccount: stringOrders(legacy.sessionOrderByAccount),
      sessionUpdatedAtByAccount: timestampOrders(legacy.sessionUpdatedAtByAccount),
      sessionMeta: migrateSessionMeta(legacy.sessionMeta),
      knownGroups,
    }
    localStorage.setItem(PERSIST_KEY, JSON.stringify(migrated))
  } catch {
    // Invalid or unavailable legacy storage leaves the v7 defaults intact.
  }
}

function isGroupAccount(key: string): boolean {
  return key.startsWith(GROUP_SECTION_PREFIX)
}

/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore(): EngineStoreHandle<WorkspaceViewState, WorkspaceViewActions> {
  migrateLegacyState()
  return defineStore({
    init: defaultState,
    persist: PERSIST_KEY,
    actions: {
      setGroupBy: (d, mode: SessionGroupBy) => { d.groupBy = mode },
      setOrderBy: (d, mode: SessionOrderBy) => { d.orderBy = mode },
      setUnreadOnly: (d, unreadOnly: boolean) => { d.unreadOnly = unreadOnly },
      setGroupExpanded: (d, key: string, expanded: boolean) => { d.groupExpansion[key] = expanded },
      retainAccountKeys: (d, workspaceKeys: readonly string[]) => {
        const retained = new Set(workspaceKeys)
        const keep = (key: string) => retained.has(key) || isGroupAccount(key)
        d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => keep(key)))
        d.sessionOrderByAccount = Object.fromEntries(
          Object.entries(d.sessionOrderByAccount).filter(([key]) => keep(key)),
        )
        d.sessionUpdatedAtByAccount = Object.fromEntries(
          Object.entries(d.sessionUpdatedAtByAccount).filter(([key]) => keep(key)),
        )
      },
      syncSessionOrderAccount: (d, accountKey: string, order: string[], updatedAt: Record<string, number>) => {
        d.sessionOrderByAccount[accountKey] = order
        d.sessionUpdatedAtByAccount[accountKey] = updatedAt
      },
      setSessionOrder: (d, accountKey: string, order: string[]) => {
        d.sessionOrderByAccount[accountKey] = order
      },
      setSessionGroup: (d, sessionId: string, value: string | undefined) => {
        const group = normalizeGroupName(value)
        if (group === undefined) {
          const { group: _drop, ...rest } = d.sessionMeta[sessionId] ?? {}
          void _drop
          d.sessionMeta[sessionId] = rest
        } else {
          d.sessionMeta[sessionId] = { ...d.sessionMeta[sessionId], group }
        }
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
      addKnownGroup: (d, value: string) => {
        const group = normalizeGroupName(value)
        if (group !== undefined && !d.knownGroups.includes(group)) d.knownGroups = [...d.knownGroups, group]
      },
      removeGroup: (d, value: string) => {
        const group = normalizeGroupName(value)
        if (group === undefined) return
        d.knownGroups = d.knownGroups.filter(item => item !== group)
        for (const [id, entry] of Object.entries(d.sessionMeta)) {
          if (entry.group === group) {
            const { group: _drop, ...rest } = entry
            void _drop
            d.sessionMeta[id] = rest
          }
        }
        const account = GROUP_SECTION_PREFIX + group
        d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => key !== account))
        d.sessionOrderByAccount = Object.fromEntries(
          Object.entries(d.sessionOrderByAccount).filter(([key]) => key !== account),
        )
        d.sessionUpdatedAtByAccount = Object.fromEntries(
          Object.entries(d.sessionUpdatedAtByAccount).filter(([key]) => key !== account),
        )
      },
    },
  })
}
