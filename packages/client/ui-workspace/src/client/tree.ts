/**
 * Derives the workspace browser tree from Host Workspace order and membership.
 * Unassigned Sessions trail under Ungrouped; only the selected blank Session
 * remains visible.
 */
import {
  indexSubagentDescendants, type PendingInteractionStatus, type SessionId, type SessionListState,
  type SessionSearchResultItem, type SessionSummary, type SubagentDescendantSummary,
  type WorkspaceId, type WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { GROUP_SECTION_PREFIX, UNASSIGNED_GROUP_KEY } from './group-keys.ts'
import type { SessionMeta } from './stores.ts'

/** Group key for Sessions outside every Workspace. */
export const UNGROUPED_KEY = ''

/** Display label for the ungrouped bucket row. */
export const UNGROUPED_LABEL = 'Ungrouped'

/** One top-level session row in a group or the flat list. */
export interface SessionNode {
  id: SessionId
  /** Stored display title; the renderer substitutes the localized New Session label for blank rows. */
  title: string
  /** The provisional blank session (renderer shows the localized New Session title). */
  blank: boolean
  /** The runtime Session list reports an interaction awaiting this user. */
  pendingInteraction?: PendingInteractionStatus
  running: boolean
  /** Running descendants connected through uninterrupted subagent-origin lineage. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the green "done" reminder dot). */
  completed: boolean
  updatedAt: number
  /** Nesting level from browser-local waiting-on parents (0 = top-level row). */
  depth: number
  /** Exclusive user-managed group; absent means Unassigned. */
  group?: string
  /** Backing Workspace of this session; absent when it belongs to no Workspace. */
  workspaceId?: WorkspaceId
  /** Manually marked unread; the row shows a dot until the session is opened. */
  unread: boolean
}

/** Session order selected by the Workspace browser. */
export type SessionOrderBy = 'manual' | 'updated'

/** One workspace group section: header row facts + visible top-level session rows. */
export interface GroupNode {
  /** Group key: the workspace id or {@link UNGROUPED_KEY}. */
  key: string
  /** Backing Workspace id; absent only for the ungrouped bucket. */
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  /** Workspace creation time (epoch ms); absent only for the ungrouped bucket. */
  createdAt: number | undefined
  label: string
  /** Total visible sessions in the group. */
  sessionCount: number
  expanded: boolean
  /** The group contains the selected session (active folder tint; supplied here so the renderer never scans). */
  containsCurrent: boolean
  /** Visible session rows (empty while the group is folded). */
  sessions: readonly SessionNode[]
  /** User-group flavor; absent for workspace groups and the ungrouped bucket. */
  kind?: 'group' | 'unassigned'
}

/** One flat search row combining list metadata with an optional content match. */
export interface SearchResultNode {
  id: SessionId
  title: string
  workspace: string
  /** The runtime Session list reports an interaction awaiting this user. */
  pendingInteraction?: PendingInteractionStatus
  running: boolean
  /** Running descendants connected through uninterrupted subagent-origin lineage. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the green "done" reminder dot). */
  completed: boolean
  snippet?: string
}

/** Bounded merged search projection plus the refine-query hint bit. */
export interface SearchResultSet {
  items: readonly SearchResultNode[]
  hasMore: boolean
}

/** Viewing state consumed by the derivation. */
export interface TreeView {
  expandedGroups: readonly string[]
  /** Browser-local order for Sessions without a backing Workspace account. */
  ungroupedOrder?: readonly string[]
  /** Browser-local organization metadata (exclusive group + waiting-on parent). */
  sessionMeta?: Readonly<Record<string, SessionMeta>>
  /** Explicitly created groups; empty sections stay visible. */
  knownGroups?: readonly string[]
  /** User-arranged card/session order per group account. */
  sessionOrderByAccount?: Readonly<Record<string, readonly string[]>>
  /** Unread-only filter: rows without the unread flag are hidden. */
  unreadOnly?: boolean
}

interface Group {
  key: string
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  createdAt: number | undefined
  label: string
  sessions: SessionSummary[]
}

/**
 * Directory display label: basename of the path (both separators accepted).
 * Ungrouped-bucket fallback for surfaces without a workspace title.
 * @param cwd - directory path, or undefined for the ungrouped bucket.
 * @returns basename, the raw cwd when it has no basename, or the ungrouped label.
 */
export function workspaceLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return UNGROUPED_LABEL
  const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base !== undefined && base !== '' ? base : cwd
}

/** Recency comparator: newest first, id as the deterministic tiebreak (ids are unique per group). */
function byRecency(a: SessionSummary, b: SessionSummary): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : 1
}

/**
 * Ordinary sessions are visible; among blank sessions, only the current one
 * is visible. Subagent children use their parent header catalog; archived
 * sessions are visible nowhere, while their accounting slots remain so
 * unarchiving restores position.
 */
function sessionVisible(session: SessionSummary, current: SessionId | undefined, archived: ReadonlySet<SessionId>): boolean {
  return session.origin !== 'subagent'
    && !archived.has(session.id)
    && (!session.blank || session.id === current)
}

/**
 * A blank session is the selected Workspace's provisional New Session row;
 * its canonical title never enters search (blank rows are query-excluded)
 * and the renderer localizes its display label.
 */
function sessionTitle(session: SessionSummary): string {
  return session.blank ? 'New Session' : session.displayTitle
}

/** Build one group without projecting session lineage into presentation. */
function buildGroup(
  key: string,
  workspaceId: WorkspaceId | undefined,
  cwd: string | undefined,
  createdAt: number | undefined,
  label: string,
  members: readonly SessionSummary[],
  order: 'account' | 'recency',
): Group {
  const sessions = [...members]
  // Real Workspace order comes from sessionIds. Ungrouped falls back to
  // recency until the browser supplies its persisted local order.
  if (order === 'recency') sessions.sort(byRecency)
  return { key, workspaceId, cwd, createdAt, label, sessions }
}

/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
function orderedUngrouped(members: readonly SessionSummary[], stored: readonly string[]): SessionSummary[] {
  const byId = new Map(members.map(session => [session.id, session]))
  const included = new Set<string>()
  const ordered: SessionSummary[] = []
  for (const key of stored) {
    const session = byId.get(key as SessionId)
    if (session === undefined || included.has(key)) continue
    ordered.push(session)
    included.add(key)
  }
  for (const session of [...members].sort(byRecency)) {
    if (included.has(session.id)) continue
    ordered.push(session)
  }
  return ordered
}

/**
 * Group Sessions by Host Workspace: one group per entity in stable Host
 * order, with members resolved from sessionIds in their stored order. Sessions
 * outside every Workspace trail in the browser-local Ungrouped order, which
 * falls back to recency before that order is initialized.
 */
function groupByWorkspace(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archived: ReadonlySet<SessionId>,
  ungroupedOrder: readonly string[] | undefined,
  unreadOnly: boolean,
  meta: Readonly<Record<string, SessionMeta>> | undefined,
): Group[] {
  const groups: Group[] = []
  const accounted = new Set<SessionId>()
  const keep = (summary: SessionSummary) =>
    sessionVisible(summary, list.current, archived)
    && (!unreadOnly || meta?.[summary.id]?.unread === true)
  for (const workspace of workspaces) {
    const members: SessionSummary[] = []
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id]
      if (summary === undefined) continue // account may lead the list pull; the row appears when the summary lands
      accounted.add(id)
      if (!keep(summary)) continue
      members.push(summary)
    }
    groups.push(buildGroup(
      workspace.workspaceId, workspace.workspaceId, workspace.path,
      Date.parse(workspace.createdAt), workspace.title, members, 'account',
    ))
  }
  const stray = list.ids
    .map(id => list.byId[id])
    .filter((s): s is SessionSummary =>
      s !== undefined && !accounted.has(s.id) && keep(s))
  if (stray.length > 0) {
    groups.push(buildGroup(
      UNGROUPED_KEY,
      undefined,
      undefined,
      undefined,
      UNGROUPED_LABEL,
      ungroupedOrder === undefined ? stray : orderedUngrouped(stray, ungroupedOrder),
      ungroupedOrder === undefined ? 'recency' : 'account',
    ))
  }
  return groups
}

function sessionNode(
  s: SessionSummary,
  descendants: ReadonlyMap<SessionId, SubagentDescendantSummary>,
  depth: number,
  meta: Readonly<Record<string, SessionMeta>> | undefined,
  workspaceId: WorkspaceId | undefined,
): SessionNode {
  // Only the browser-local group feeds grouping; model-written todo tags stay
  // separate so agents cannot reorganize the sidebar or board.
  const entry = meta?.[s.id]
  return {
    id: s.id,
    title: sessionTitle(s),
    blank: s.blank,
    running: s.running,
    runningSubagentCount: descendants.get(s.id)?.runningCount ?? 0,
    completed: s.completed === true,
    updatedAt: s.updatedAt,
    depth,
    unread: entry?.unread === true,
    ...(entry?.group === undefined ? {} : { group: entry.group }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(s.pendingInteraction === undefined ? {} : { pendingInteraction: s.pendingInteraction }),
  }
}

/**
 * Reorder one group's members so each session with a browser-local
 * waiting-on parent follows its parent (children nested at depth+1), and
 * report each row's nesting depth. Parents outside the group are ignored;
 * cycles are broken by treating leftover members as top-level rows.
 * @param members - group members in their stored order.
 * @param meta - browser-local session metadata.
 * @returns rows in parent-first order with nesting depths.
 */
function waitingOrder(
  members: readonly SessionSummary[],
  meta: Readonly<Record<string, SessionMeta>> | undefined,
): { session: SessionSummary; depth: number }[] {
  const childOf = new Map<string, string>()
  const present = new Set(members.map(session => session.id))
  for (const [id, entry] of Object.entries(meta ?? {})) {
    if (entry.parent !== undefined && entry.parent !== id && present.has(entry.parent as SessionId)) {
      childOf.set(id, entry.parent)
    }
  }
  const out: { session: SessionSummary; depth: number }[] = []
  const placed = new Set<string>()
  const place = (session: SessionSummary, depth: number): void => {
    if (placed.has(session.id)) return
    placed.add(session.id)
    out.push({ session, depth: Math.min(depth, 8) })
    for (const candidate of members) {
      if (childOf.get(candidate.id) === session.id) place(candidate, depth + 1)
    }
  }
  for (const session of members) if (!childOf.has(session.id)) place(session, 0)
  for (const session of members) if (!placed.has(session.id)) place(session, 0)
  return out
}

/**
 * Derive the workspace browser groups with every session as a top-level row.
 *
 * Every group shows; sessions populate under expanded groups in the selected
 * local order. Blank sessions are excluded except for the selected
 * provisional New Session row; archived sessions are excluded everywhere.
 * Content search lives outside this derivation
 * (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot (`current` feeds containsCurrent).
 * @param workspaces - real workspaces in stable Host order.
 * @param archivedSessionIds - registry-global archive set.
 * @param view - local expansion arrays.
 * @returns group sections in render order.
 */
export function deriveGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[],
  view: TreeView,
): GroupNode[] {
  const archived = new Set(archivedSessionIds)
  const expandedGroups = new Set(view.expandedGroups)
  const descendants = indexSubagentDescendants(list.byId)
  const unreadOnly = view.unreadOnly === true
  const currentGroup = list.current === undefined
    ? undefined
    : (workspaces.find(w => w.sessionIds.includes(list.current as SessionId))?.workspaceId as string | undefined)
        ?? UNGROUPED_KEY
  const groups: GroupNode[] = []
  for (const g of groupByWorkspace(list, workspaces, archived, view.ungroupedOrder, unreadOnly, view.sessionMeta)) {
    // Unread-only mode hides groups with nothing unread in them.
    if (unreadOnly && g.sessions.length === 0) continue
    const expanded = expandedGroups.has(g.key)
    groups.push({
      key: g.key,
      workspaceId: g.workspaceId,
      cwd: g.cwd,
      createdAt: g.createdAt,
      label: g.label,
      sessionCount: g.sessions.length,
      expanded,
      containsCurrent: g.key === currentGroup,
      sessions: expanded
        ? waitingOrder(g.sessions, view.sessionMeta).map(row =>
          sessionNode(row.session, descendants, row.depth, view.sessionMeta, g.workspaceId))
        : [],
    })
  }
  return groups
}

/**
 * Derive exclusive user-group sections. Every visible session appears in
 * exactly one named group or the Unassigned bucket; model-written todo tags
 * never participate. Group and board views share the same per-group order.
 * @param list - sessions list snapshot.
 * @param workspaces - real Workspaces (session membership → workspace id).
 * @param archivedSessionIds - registry-global archive set.
 * @param view - persisted expansion, grouping metadata, and order accounts.
 * @returns named groups in locale order, then the Unassigned bucket.
 */
export function deriveUserGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[],
  view: TreeView,
): GroupNode[] {
  const archived = new Set(archivedSessionIds)
  const expandedGroups = new Set(view.expandedGroups)
  const descendants = indexSubagentDescendants(list.byId)
  const meta = view.sessionMeta
  const unreadOnly = view.unreadOnly === true
  const workspaceBySession = new Map<SessionId, WorkspaceId>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.workspaceId)
    }
  }
  const byGroup = new Map<string, SessionSummary[]>()
  const unassigned: SessionSummary[] = []
  for (const id of list.ids) {
    const session = list.byId[id]
    if (session === undefined || !sessionVisible(session, list.current, archived)) continue
    if (unreadOnly && meta?.[id]?.unread !== true) continue
    const group = meta?.[id]?.group
    if (group === undefined) {
      unassigned.push(session)
    } else {
      const members = byGroup.get(group)
      if (members === undefined) byGroup.set(group, [session])
      else members.push(session)
    }
  }
  const groups: GroupNode[] = []
  const names = new Set([...byGroup.keys(), ...(view.knownGroups ?? [])])
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const key = GROUP_SECTION_PREFIX + name
    const members = orderedUngrouped(byGroup.get(name) ?? [], view.sessionOrderByAccount?.[key] ?? [])
    if (unreadOnly && members.length === 0) continue
    const expanded = expandedGroups.has(key)
    groups.push({
      key,
      workspaceId: undefined,
      cwd: undefined,
      createdAt: undefined,
      label: name,
      sessionCount: members.length,
      expanded,
      containsCurrent: members.some(session => session.id === list.current),
      sessions: expanded
        ? waitingOrder(members, meta).map(row =>
          sessionNode(row.session, descendants, row.depth, meta, workspaceBySession.get(row.session.id)))
        : [],
      kind: 'group',
    })
  }
  if (unassigned.length > 0) {
    const members = orderedUngrouped(unassigned, view.sessionOrderByAccount?.[UNASSIGNED_GROUP_KEY] ?? [])
    const expanded = expandedGroups.has(UNASSIGNED_GROUP_KEY)
    groups.push({
      key: UNASSIGNED_GROUP_KEY,
      workspaceId: undefined,
      cwd: undefined,
      createdAt: undefined,
      label: '',
      sessionCount: members.length,
      expanded,
      containsCurrent: members.some(session => session.id === list.current),
      sessions: expanded
        ? waitingOrder(members, meta).map(row =>
          sessionNode(row.session, descendants, row.depth, meta, workspaceBySession.get(row.session.id)))
        : [],
      kind: 'unassigned',
    })
  }
  return groups
}

/**
 * Derive the flat session list ("In one list" mode): every session — fork
 * children included — as a top-level row, strictly newest-first. No grouping,
 * no parent/child adjacency. Content search lives outside this derivation
 * (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot.
 * @param workspaces - real Workspaces (session membership → workspace id).
 * @param archivedSessionIds - registry-global archive set.
 * @param meta - browser-local organization metadata (tags, unread).
 * @param unreadOnly - hide rows without the unread flag.
 * @returns flat rows in render order.
 */
export function deriveFlat(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[],
  meta?: Readonly<Record<string, SessionMeta>>,
  unreadOnly = false,
): SessionNode[] {
  const archived = new Set(archivedSessionIds)
  const descendants = indexSubagentDescendants(list.byId)
  const workspaceBySession = new Map<SessionId, WorkspaceId>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.workspaceId)
    }
  }
  const rows: SessionSummary[] = []
  for (const id of list.ids) {
    const s = list.byId[id]
    if (s === undefined || !sessionVisible(s, list.current, archived)) continue
    if (unreadOnly && meta?.[s.id]?.unread !== true) continue
    rows.push(s)
  }
  rows.sort(byRecency)
  return rows.map(session => sessionNode(session, descendants, 0, meta, workspaceBySession.get(session.id)))
}

/** Relative-time bucket of a session row's trailing label. */
export type RelativeTimeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'

/** Structured relative time: the bucket plus its magnitude (0 for 'now'). */
export interface RelativeTime {
  unit: RelativeTimeUnit
  n: number
}

/**
 * Merge immediate title/Workspace substring matches with ranked Host content
 * matches. Local rows lead newest-first, content-only rows retain backend
 * order, and duplicate sessions receive the backend snippet in place.
 * @param list - session metadata authority.
 * @param workspaces - Workspace membership and display labels.
 * @param query - caller text; surrounding whitespace is ignored.
 * @param archivedSessionIds - registry-global archive set (members never match).
 * @param content - ranked Host content-search page.
 * @param limit - protocol-owned maximum merged row count.
 * @returns bounded deduplicated flat rows and a refine-query hint bit.
 */
export function deriveSearchResults(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  query: string,
  archivedSessionIds: readonly SessionId[],
  content: { items: readonly SessionSearchResultItem[]; hasMore: boolean },
  limit: number,
): SearchResultSet {
  const q = query.trim().toLowerCase()
  if (q === '') return { items: [], hasMore: false }
  const archived = new Set(archivedSessionIds)
  const descendants = indexSubagentDescendants(list.byId)

  const workspaceBySession = new Map<SessionId, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.title)
    }
  }
  const labelOf = (summary: SessionSummary): string =>
    workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd)
  const contentBySession = new Map<SessionId, SessionSearchResultItem>()
  for (const item of content.items) {
    if (!contentBySession.has(item.sessionId)) contentBySession.set(item.sessionId, item)
  }

  const local: SessionSummary[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    // Blank placeholders never match a query (their canonical title displays
    // localized, so matching it would tie search to one language).
    if (summary === undefined || summary.blank || !sessionVisible(summary, list.current, archived)) continue
    if (
      sessionTitle(summary).toLowerCase().includes(q)
      || labelOf(summary).toLowerCase().includes(q)
    ) {
      local.push(summary)
    }
  }
  local.sort(byRecency)

  const ordered: SessionSummary[] = []
  const included = new Set<SessionId>()
  const include = (summary: SessionSummary): void => {
    if (included.has(summary.id)) return
    included.add(summary.id)
    ordered.push(summary)
  }
  for (const summary of local) include(summary)
  for (const item of content.items) {
    const summary = list.byId[item.sessionId]
    if (summary !== undefined && !summary.blank && sessionVisible(summary, list.current, archived)) include(summary)
  }

  return {
    items: ordered.slice(0, limit).map((summary) => {
      const match = contentBySession.get(summary.id)
      return {
        id: summary.id,
        title: sessionTitle(summary),
        workspace: labelOf(summary),
        running: summary.running,
        runningSubagentCount: descendants.get(summary.id)?.runningCount ?? 0,
        ...(summary.pendingInteraction === undefined
          ? {}
          : { pendingInteraction: summary.pendingInteraction }),
        completed: summary.completed === true,
        ...match === undefined ? {} : { snippet: match.snippet },
      }
    }),
    hasMore: content.hasMore || ordered.length > limit,
  }
}

/**
 * Compact relative time for session rows, as a structured bucket the
 * renderer localizes ("now"/"5min"/"3h"/"2d"/"4mo"/"1y" in en).
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms (injected for pure rendering).
 * @returns the row's trailing time bucket and magnitude.
 */
export function relativeTime(updatedAt: number, now: number): RelativeTime {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - updatedAt)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}
