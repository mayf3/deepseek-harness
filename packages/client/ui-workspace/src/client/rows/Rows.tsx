/**
 * Workspace browser tree row components (figma Cell set 14:3080): pure presentational —
 * all data and callbacks arrive via props. Hover swaps (folder->chevron,
 * time->ellipsis, action buttons) are CSS-only. Row ... menus are visual-only
 * except workspace Rename/Delete and session Rename/Fork/Archive; the session
 * and workspace hover cards are suppressed while a menu is open.
 */
import { useState } from 'react'
import clsx from 'clsx'
import {
  HoverCard, IconArchiveOutline20, IconBranchOutline16, IconEditOutline16,
  IconEllipsisOutline16, IconFolderClose16, IconFolderOpen16, IconLinkOutline16, IconPlusOutline16,
  IconTrashOutline16, IconTriangleRightFill14, Menu, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { abbreviateHomePath } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { GroupNode, SearchResultNode, SessionNode } from '../tree.ts'
import { relativeTime } from '../tree.ts'
import css from './Rows.module.css'

/** The standard locale seat, prop-passed from the browser root. */
type RowTranslate = WorkspaceBrowserProps['t']

/** Row display title: blank rows show the localized New Session label. */
function displayTitle(node: SessionNode, t: RowTranslate): string {
  return node.blank ? t('session.new') : node.title
}

/** Localized compact relative time ("刚刚"/"5分钟" in zh, "now"/"5min" in en). */
function timeLabel(updatedAt: number, now: number, t: RowTranslate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/** Hover-card variant: distances wrap in the ago template; the now bucket stays bare (no "now ago"). */
function hoverTimeLabel(updatedAt: number, now: number, t: RowTranslate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t('time.ago', { t: t(`time.${unit}`, { n }) })
}

/**
 * Absolute creation time through the dictionary's date template (the message
 * clock pattern): `toLocaleString` would follow the browser language, not the
 * app locale, and produce mixed-language text after a switch.
 */
function createdLabel(createdAt: number, t: RowTranslate): string {
  const d = new Date(createdAt)
  const pad2 = (v: number): string => String(v).padStart(2, '0')
  const date = t('date.ymd', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
  return t('hover.created', { time: `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` })
}

/** Hover-card body: workspace title, display directory path, absolute creation time. */
function WorkspaceHoverContent({ label, cwd, createdAt, t }: {
  label: string
  cwd: string | undefined
  createdAt: number
  t: RowTranslate
}) {
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{label}</div>
      <div className={css.hoverPath}>{cwd}</div>
      <div className={css.hoverTime}>{createdLabel(createdAt, t)}</div>
    </div>
  )
}

/**
 * Row drag wiring supplied by the tree owner. `drop` reports the half of the
 * row where the pointer released so the owner can resolve an insert anchor.
 */
export interface RowDragProps {
  /** Start dragging this row. */
  start: () => void
  /** A compatible row drag is in flight. */
  active: boolean
  /** Current marker on this row: insert line above/below, or 'on' = nest under. */
  marker: 'before' | 'after' | 'on' | null
  /** Report the hovered zone while a compatible drag passes over this row. */
  hover: (half: 'before' | 'after' | 'on') => void
  drop: (half: 'before' | 'after' | 'on') => void
  end: () => void
}

/** Drag lifecycle owned by a workspace row; its enclosing group owns hit testing. */
interface WorkspaceRowDragProps {
  start: () => void
  end: () => void
}

/**
 * Pointer-position zone of a row: the middle band drops the dragged session
 * UNDER the target (waiting-on parent); the top/bottom bands keep the insert
 * line (reorder) semantics.
 */
function rowHalf(e: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' | 'on' {
  const rect = e.currentTarget.getBoundingClientRect()
  const ratio = rect.height === 0 ? 0.5 : (e.clientY - rect.top) / rect.height
  if (ratio < 0.3) return 'before'
  if (ratio > 0.7) return 'after'
  return 'on'
}

/**
 * Project (workspace) header row: folder + title;
 * hover reveals the chevron and create button, and dwelling on a real
 * Workspace shows its hover card (the ungrouped bucket has none).
 * `containsCurrent` arrives on the node (derivation fact, no renderer scan).
 * @param props.group - derived group node.
 * @param props.onToggle - expand/collapse the group.
 * @param props.onCreate - start a frontend Session inside this Workspace.
 * @param props.drag - optional workspace-row drag wiring.
 * @param props.home - host account home for POSIX hover-path abbreviation.
 * @param props.t - the browser root's locale seat.
 * @returns the row element.
 */
export function ProjectRowItem({ group, onToggle, onCreate, actions, onDeleteGroup, drag, dropTarget, home, t }: {
  group: GroupNode
  onToggle: () => void
  onCreate: () => void
  /** Real-Workspace actions; absent for the ungrouped bucket (no menu shown). */
  actions?: { rename: () => void; delete: () => void } | undefined
  /** Delete the whole user group (group-view sections only). */
  onDeleteGroup?: (() => void) | undefined
  /** Present only for real Workspace rows in the grouped view. */
  drag?: WorkspaceRowDragProps | undefined
  /** Group-view drop target: dropping a session on the section header moves it into/out of that group. */
  dropTarget?: { active: boolean; onDrop: () => void } | undefined
  /** Host account home; POSIX home-rooted hover paths display as `~`. */
  home?: string | undefined
  t: RowTranslate
}) {
  const row = group
  // User-group sections show the group name; Unassigned and Ungrouped
  // bucket have dictionary copy (no backing Workspace title).
  const label = row.kind === 'group' ? row.label
    : row.kind === 'unassigned' ? t('group.unassigned')
      : row.workspaceId === undefined ? t('group.ungrouped')
        : row.label
  const active = group.expanded && group.containsCurrent
  const [menuOpen, setMenuOpen] = useState(false)
  const workspaceMenuItems = [
    { id: 'rename', label: t('rename'), icon: <IconEditOutline16 /> },
    { id: 'delete', label: t('delete.workspace'), icon: <IconTrashOutline16 />, danger: true },
  ]
  const groupMenuItems = onDeleteGroup === undefined ? [] : [
    { id: 'deleteGroup', label: t('menu.deleteGroup'), icon: <IconTrashOutline16 />, danger: true },
  ]
  const menuItems = actions !== undefined ? workspaceMenuItems : groupMenuItems
  const ownRow = (
    <div
      className={clsx(css.projectRow, menuOpen && css.menuOpen, dropTarget?.active && css.dropTarget)}
      role="treeitem"
      aria-expanded={row.expanded}
      onClick={onToggle}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
      draggable={drag !== undefined}
      onDragStart={drag === undefined
        ? undefined
        : (e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', row.key)
          drag.start()
        }}
      onDragEnd={drag?.end}
      onDragOver={dropTarget === undefined || !dropTarget.active
        ? undefined
        : (e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
      onDrop={dropTarget === undefined || !dropTarget.active
        ? undefined
        : (e) => {
          e.preventDefault()
          dropTarget.onDrop()
        }}
    >
      <span className={clsx(css.slot, css.folder, active && css.folderActive)}>
        {row.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
      </span>
      <span className={clsx(css.slot, css.chevron)}>
        <IconTriangleRightFill14 className={clsx(css.arrow, row.expanded && css.arrowOpen)} />
      </span>
      <span className={css.projectText}>
        <span className={css.title}>{label}</span>
      </span>
      <span className={css.rowActions}>
        {(actions !== undefined || onDeleteGroup !== undefined) && (
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={menuItems}
            onSelect={(id) => {
              setMenuOpen(false)
              if (actions !== undefined && id === 'rename') actions.rename()
              else if (actions !== undefined && id === 'delete') actions.delete()
              else if (onDeleteGroup !== undefined && id === 'deleteGroup') onDeleteGroup()
            }}
            portal
            closeOnPointerLeave
            anchor={(
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('actions.workspace.aria', { name: label })}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        )}
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('actions.newSession.aria', { name: label })}
          onClick={(e) => { e.stopPropagation(); onCreate() }}
        >
          <IconPlusOutline16 />
        </button>
      </span>
    </div>
  )
  // The ungrouped bucket has no backing Workspace: no card to show.
  if (row.createdAt === undefined) return ownRow
  return (
    <HoverCard
      anchor={ownRow}
      content={<WorkspaceHoverContent
        label={row.label}
        cwd={row.cwd === undefined ? undefined : abbreviateHomePath(row.cwd, home)}
        createdAt={row.createdAt}
        t={t}
      />}
      disabled={menuOpen}
      copyText={row.cwd}
      copyLabel={t('copy')}
      copiedLabel={t('hover.copied')}
    />
  )
}

/* v8 ignore next 3 -- closed-union backstop; only reached if the status is forged */
function assertNever(value: never): never {
  throw new Error(`unknown pending interaction: ${String(value)}`)
}

interface SessionStatus {
  state: StateDotState
  label: string
}

/**
 * Session status presentation; pending interaction is primary and live activity
 * outranks completion reminders.
 */
function sessionStatuses(
  node: Pick<SessionNode, 'pendingInteraction' | 'running' | 'runningSubagentCount' | 'completed'>,
  t: RowTranslate,
): readonly [SessionStatus, ...SessionStatus[]] {
  const subagents: SessionStatus | undefined = node.runningSubagentCount === 0
    ? undefined
    : {
      state: 'ongoing',
      label: t(
        node.runningSubagentCount === 1
          ? 'status.subagentsRunning.one'
          : 'status.subagentsRunning.other',
        { n: node.runningSubagentCount },
      ),
    }
  let pending: SessionStatus | undefined
  switch (node.pendingInteraction) {
    case 'approval':
      pending = { state: 'warning', label: t('status.waitingApproval') }
      break
    case 'plan-review':
      pending = { state: 'warning', label: t('status.planReview') }
      break
    case 'question':
      pending = { state: 'warning', label: t('status.waitingAnswer') }
      break
    case undefined: break
    /* v8 ignore next -- closed PendingInteractionStatus union */
    default: return assertNever(node.pendingInteraction)
  }
  if (pending !== undefined) return subagents === undefined ? [pending] : [pending, subagents]
  if (node.running) {
    const primary: SessionStatus = { state: 'ongoing', label: t('status.running') }
    return subagents === undefined ? [primary] : [primary, subagents]
  }
  if (subagents !== undefined) return [subagents]
  if (node.completed) return [{ state: 'done', label: t('status.completed') }]
  return [{ state: 'done', label: t('status.idle') }]
}

/** Primary status dot plus every status's screen-reader label, shared by the search and session rows. */
function SessionStatusDots({ statuses }: { statuses: readonly [SessionStatus, ...SessionStatus[]] }) {
  return (
    <>
      <StateDot state={statuses[0].state} />
      {statuses.map(status => (
        <span className={css.visuallyHidden} key={status.label}>{status.label}</span>
      ))}
    </>
  )
}

/** Hover-card body: full title, relative time, and every relevant live status. */
function SessionHoverContent({ node, now, t }: { node: SessionNode; now: number; t: RowTranslate }) {
  const statuses = sessionStatuses(node, t)
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{displayTitle(node, t)}</div>
      {/* Same placeholder rule as the row's trailing cell: no timestamp
          before the first prompt. */}
      {!node.blank && <div className={css.hoverTime}>{hoverTimeLabel(node.updatedAt, now, t)}</div>}
      {statuses.map(status => (
        <div className={css.hoverStatus} key={status.label}>
          <StateDot state={status.state} />
          <span>{status.label}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * One flat search result: title, Workspace context, and optional content
 * excerpt. Search navigation opens the session only; it does not address an
 * event inside the conversation.
 * @param props.result - merged local/content search row.
 * @param props.currentId - selected session id.
 * @param props.onOpen - open the selected session.
 * @param props.t - Workspace-browser translation seat.
 * @returns the result button.
 */
export function SearchResultItem({ result, currentId, onOpen, t }: {
  result: SearchResultNode
  currentId: string | undefined
  onOpen: (id: SearchResultNode['id']) => void
  t: RowTranslate
}) {
  const selected = result.id === currentId
  const statuses = sessionStatuses(result, t)
  const primaryStatus = statuses[0]
  return (
    <button
      type="button"
      className={clsx(css.searchResultRow, selected && css.selected)}
      role="treeitem"
      aria-selected={selected}
      onClick={() => { onOpen(result.id) }}
    >
      <span className={css.searchResultHeading}>
        <span className={css.slot}>
          {(primaryStatus.state !== 'done' || result.completed) && (
            <SessionStatusDots statuses={statuses} />
          )}
        </span>
        <span className={css.searchResultTitle}>{result.title}</span>
      </span>
      <span className={css.searchResultMeta}>
        <span className={css.searchResultWorkspace}>{result.workspace}</span>
        {result.snippet !== undefined && (
          <span className={css.searchResultSnippet}>{result.snippet}</span>
        )}
      </span>
    </button>
  )
}

/**
 * One top-level 34px session row: status dot (pending user interaction outranks
 * own or descendant activity), title, relative time, and the row actions menu.
 * @param props.node - derived session node.
 * @param props.currentId - selected session id (row highlight).
 * @param props.now - epoch ms for relative-time formatting.
 * @param props.onOpen - open a session by id.
 * @param props.onRename - open the session rename dialog (id + current title).
 * @param props.onFork - fork a session at its last completed turn.
 * @param props.onArchive - archive a session by id.
 * @param props.drag - optional draggable-row wiring.
 * @param props.flat - omit the empty status slot in the hierarchy-free flat list.
 * @param props.t - the browser root's locale seat.
 * @returns the session row.
 */
export function SessionNodeItem({
  node, currentId, now, onOpen, onRename, onFork, onArchive, onEditGroup, onNewSession, onToggleUnread,
  selection, drag, flat = false, t,
}: {
  node: SessionNode
  currentId: string | undefined
  now: number
  onOpen: (id: SessionNode['id']) => void
  /** Open the browser-owned session rename dialog (row menu action). */
  onRename: (id: SessionNode['id'], currentTitle: string) => void
  /** Fork a session at its last completed turn (row menu action). */
  onFork: (id: SessionNode['id']) => void
  /** Archive this session (row menu action; commits without a dialog). */
  onArchive: (id: SessionNode['id']) => void
  /** Open the group editor for this session (row menu action). */
  onEditGroup: (id: SessionNode['id'], currentGroup: string | undefined) => void
  /** Start a new session in this row's Workspace (row menu action; absent outside directory view). */
  onNewSession?: (() => void) | undefined
  /** Toggle this session's unread flag (row menu action; absent on non-actionable rows). */
  onToggleUnread?: ((id: SessionNode['id']) => void) | undefined
  /** Batch-selection state; while present, row gestures select instead of opening or dragging. */
  selection?: {
    checked: boolean
    onToggle: (checked: boolean, shiftKey: boolean) => void
  } | undefined
  /** Present only on draggable rows (workspace-group sessions outside search). */
  drag?: RowDragProps | undefined
  /** The row is rendered without a parent Workspace header. */
  flat?: boolean | undefined
  t: RowTranslate
}) {
  const row = node
  const title = displayTitle(node, t)
  const selected = node.id === currentId
  const batchSelected = selection?.checked === true
  const statuses = sessionStatuses(node, t)
  const primaryStatus = statuses[0]
  const showStatus = primaryStatus.state !== 'done' || row.completed
  const [menuOpen, setMenuOpen] = useState(false)
  // Right-click menu anchor: the ellipsis trigger is gone, so the menu is
  // positioned at the cursor that opened it.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [archiveConfirming, setArchiveConfirming] = useState(false)
  // Archive keeps confirmation in the row action's original position instead
  // of opening a dialog or popover.
  const sessionMenuItems = [
    ...(onNewSession === undefined ? [] : [{ id: 'newSessionHere', label: t('menu.newSessionHere'), icon: <IconPlusOutline16 /> }]),
    ...(onToggleUnread === undefined ? [] : [{ id: 'unread', label: node.unread ? t('menu.markRead') : t('menu.markUnread'), icon: <span className={css.menuUnreadDot} aria-hidden="true" /> }]),
    { id: 'rename', label: t('rename'), icon: <IconEditOutline16 /> },
    { id: 'fork', label: t('menu.fork'), icon: <IconBranchOutline16 /> },
    { id: 'group', label: t('menu.editGroup'), icon: <IconEditOutline16 /> },
    // 20-native glyph in the menu's 16px icon slot (Menu.module.css .itemIcon).
    { id: 'archive', label: t('menu.archiveSession'), icon: <IconArchiveOutline20 size={16} /> },
  ]
  // Figma session cell: pad 8, status slot 16, then a 4px title gap.
  const ownRow = (
    <div
      className={clsx(
        css.sessionRow, selected && css.selected, batchSelected && css.batchSelected,
        (menuOpen || archiveConfirming) && css.menuOpen,
        flat && !showStatus && css.flatSessionRowWithoutStatus,
        drag?.marker === 'before' && css.dropBefore, drag?.marker === 'after' && css.dropAfter,
        drag?.marker === 'on' && css.dropOn,
      )}
      style={node.depth > 0 ? { paddingLeft: `${10 + node.depth * 16}px` } : undefined}
      role="treeitem"
      aria-selected={selection === undefined ? selected : batchSelected}
      aria-level={node.depth + 1}
      data-session-id={node.id}
      onClick={(e) => {
        if (selection === undefined) onOpen(node.id)
        else selection.onToggle(!selection.checked, e.shiftKey)
      }}
      onContextMenu={selection === undefined
        ? (e) => {
          e.preventDefault()
          setMenuAt({ x: e.clientX, y: e.clientY })
          setMenuOpen(true)
        }
        : undefined}
      draggable={selection === undefined && drag !== undefined}
      onDragStart={selection !== undefined || drag === undefined
        ? undefined
        : (e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', node.id)
          drag.start()
        }}
      onDragEnd={selection === undefined ? drag?.end : undefined}
      onDragOver={selection !== undefined || drag === undefined
        ? undefined
        : (e) => {
          if (!drag.active) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          drag.hover(rowHalf(e))
        }}
      onDrop={selection !== undefined || drag === undefined
        ? undefined
        : (e) => {
          if (!drag.active) return
          e.preventDefault()
          drag.drop(rowHalf(e))
        }}
    >
      {/* Pending interaction and own or descendant activity outrank the
          finished-but-unviewed reminder, which returns after activity stops
          and is cleared by opening the session. */}
      {selection === undefined
        ? (!flat || showStatus) && (
          <span className={css.slot}>
            {showStatus && <SessionStatusDots statuses={statuses} />}
          </span>
        )
        : (
          <input
            type="checkbox"
            className={css.batchCheckbox}
            checked={selection.checked}
            aria-label={t('bulk.selectSession', { name: title })}
            onClick={(e) => {
              e.stopPropagation()
              selection.onToggle(!selection.checked, e.shiftKey)
            }}
            readOnly
          />
        )}
      {selection === undefined && node.depth > 0 && (
        <span className={css.waitingMark} aria-label={t('status.waitingOn')} title={t('status.waitingOn')}>
          <IconLinkOutline16 />
        </span>
      )}
      {selection === undefined && node.unread && (
        <span className={css.unreadDot} aria-label={t('status.unread')} title={t('status.unread')} />
      )}
      <span className={css.title}>{title}</span>
      {/* A blank New Session row is a provisional placeholder: nothing has
          happened in it yet, so a "now" timestamp and the row verbs
          (rename/fork/archive) would all act on content that does not
          exist — both trailing cells stay off until the first prompt. */}
      {!row.blank && selection === undefined && <span className={css.time}>{timeLabel(row.updatedAt, now, t)}</span>}
      {!row.blank && selection === undefined && (
        <span className={css.rowActions}>
          {/* The first click arms the same button; the second archives. */}
          <button
            type="button"
            className={clsx(css.iconButton, archiveConfirming && css.archiveConfirm)}
            aria-label={t(archiveConfirming ? 'menu.archiveConfirm' : 'menu.archiveSession')}
            title={t(archiveConfirming ? 'menu.archiveConfirm' : 'menu.archiveSession')}
            onBlur={() => { setArchiveConfirming(false) }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setArchiveConfirming(false)
              }
            }}
            onClick={(e) => {
              e.stopPropagation()
              if (archiveConfirming) {
                setArchiveConfirming(false)
                onArchive(node.id)
              } else setArchiveConfirming(true)
            }}
          >
            <IconArchiveOutline20 size={16} />
          </button>
          {/* The full row menu lives on right-click alone (no ellipsis). */}
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={sessionMenuItems}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === 'newSessionHere') onNewSession?.()
              if (id === 'unread') onToggleUnread?.(node.id)
              if (id === 'rename') onRename(node.id, row.title)
              if (id === 'fork') onFork(node.id)
              if (id === 'archive') onArchive(node.id)
              if (id === 'group') onEditGroup(node.id, node.group)
            }}
            portal
            anchor={<span aria-hidden="true" />}
            getAnchorRect={() => {
              if (menuAt === null) return null
              return new DOMRect(menuAt.x, menuAt.y, 0, 0)
            }}
          />
        </span>
      )}
    </div>
  )
  return (
    <HoverCard
      anchor={ownRow}
      content={<SessionHoverContent node={node} now={now} t={t} />}
      disabled={selection !== undefined || menuOpen || archiveConfirming || drag?.active === true}
      copyText={row.blank ? undefined : row.title}
      copyLabel={t('copy')}
      copiedLabel={t('hover.copied')}
    />
  )
}
