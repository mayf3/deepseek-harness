import clsx from 'clsx'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react'
import { IconCheckOutline16, IconCopyOutline16 } from './icons/index.tsx'
import { Menu } from './Menu.tsx'
import type { MenuEntry } from './Menu.tsx'
import css from './JsonTree.module.css'

const OBJECT_PREVIEW_LIMIT = 4
const ARRAY_PREVIEW_LIMIT = 5
const PREVIEW_DEPTH_LIMIT = 2

/**
 * Display copy for the tree's copy affordance; the owner passes localized
 * labels (this package is cordis-free, so copy arrives via props).
 */
export interface JsonTreeLabels {
  /** Menu item: copy the raw primitive value. */
  copyValue: string
  /** Menu item: copy the value as compact JSON (primitive rows). */
  copyJson: string
  /** Menu item: copy the property path. */
  copyPath: string
  /** Menu item: copy the value as pretty-printed JSON. */
  copyPrettyJson: string
  /** Menu item: copy the value as compact JSON (object rows). */
  copyCompactJson: string
  /** Copy-button state label after a successful copy. */
  copied: string
  /** Copy-button state label after a failed copy. */
  copyFailed: string
  /** Expander aria label while expanded. */
  collapseNode: string
  /** Expander aria label while collapsed. */
  expandNode: string
  /** Copy-button tooltip, given the current action label. */
  copyButtonTitle: (action: string) => string
}

function valueCopyMenuItems(labels: JsonTreeLabels): readonly MenuEntry[] {
  return [
    { id: 'value', label: labels.copyValue },
    { id: 'json', label: labels.copyJson },
    { id: 'path', label: labels.copyPath },
  ]
}

function objectCopyMenuItems(labels: JsonTreeLabels): readonly MenuEntry[] {
  return [
    { id: 'prettyJson', label: labels.copyPrettyJson },
    { id: 'json', label: labels.copyCompactJson },
    { id: 'path', label: labels.copyPath },
  ]
}

type JsonPath = readonly (number | string)[]

interface RowTarget {
  path: JsonPath
  value: unknown
}

function isExpandableValue(value: unknown): value is object | unknown[] {
  return typeof value === 'object' && value !== null && !(value instanceof Date)
}

function entriesOf(value: object | unknown[]): readonly (readonly [string, unknown])[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item] as const)
  }
  return Object.keys(value).map(key => [
    key,
    (value as Record<string, unknown>)[key],
  ] as const)
}

function bracketOf(value: object | unknown[]): readonly [string, string] {
  return Array.isArray(value) ? ['[', ']'] : ['{', '}']
}

function previewPrimitive(value: unknown): ReactNode {
  if (value === null) return <span className={css.keywordValue}>null</span>
  if (typeof value === 'string') {
    return <span className={css.stringValue}>{JSON.stringify(value)}</span>
  }
  if (typeof value === 'number') {
    return <span className={css.numberValue}>{String(value)}</span>
  }
  if (typeof value === 'boolean') {
    return <span className={css.keywordValue}>{String(value)}</span>
  }
  if (typeof value === 'bigint') {
    return <span className={css.otherValue}>{value.toString()}</span>
  }
  if (typeof value === 'undefined') {
    return <span className={css.otherValue}>undefined</span>
  }
  if (typeof value === 'symbol') {
    return <span className={css.otherValue}>{value.description ?? 'Symbol'}</span>
  }
  if (typeof value === 'function') {
    return <span className={css.otherValue}>{value.name || 'Function'}</span>
  }
  return null
}

function previewValue(value: unknown, depth: number): ReactNode {
  if (!isExpandableValue(value)) return previewPrimitive(value)

  const array = Array.isArray(value)
  const entries = entriesOf(value)
  const limit = array ? ARRAY_PREVIEW_LIMIT : OBJECT_PREVIEW_LIMIT
  const visible = entries.slice(0, limit)
  const [open, close] = bracketOf(value)

  return (
    <>
      <span className={css.punctuation}>{open}</span>
      {depth >= PREVIEW_DEPTH_LIMIT
        ? <span className={css.previewEllipsis}>…</span>
        : visible.map(([key, item], index) => (
          <span key={key}>
            {index > 0 && <span className={css.punctuation}>, </span>}
            {!array && (
              <>
                <span className={css.previewProperty}>{key}</span>
                <span className={css.punctuation}>: </span>
              </>
            )}
            {previewValue(item, depth + 1)}
          </span>
        ))}
      {depth < PREVIEW_DEPTH_LIMIT && entries.length > limit && (
        <span className={css.previewEllipsis}>, …</span>
      )}
      <span className={css.punctuation}>{close}</span>
    </>
  )
}

function primitiveValue(value: unknown): ReactNode {
  if (value === null) return <span className={css.keywordValue}>null</span>
  if (typeof value === 'string') {
    return <span className={css.stringValue}>{JSON.stringify(value)}</span>
  }
  if (typeof value === 'boolean') {
    return <span className={css.keywordValue}>{String(value)}</span>
  }
  if (typeof value === 'number') {
    return <span className={css.numberValue}>{String(value)}</span>
  }
  if (typeof value === 'bigint') {
    return <span className={css.numberValue}>{`${value.toString()}n`}</span>
  }
  if (value instanceof Date) {
    return <span className={css.otherValue}>{value.toISOString()}</span>
  }
  if (typeof value === 'function') {
    return <span className={css.otherValue}>function() {'{ }'}</span>
  }
  if (typeof value === 'undefined') {
    return <span className={css.otherValue}>undefined</span>
  }
  return <span className={css.otherValue}>{(value as symbol).toString()}</span>
}

function fieldText(field: string): string {
  return field === '' ? '""' : field
}

function pathId(path: JsonPath): string {
  return path.map(part => (
    typeof part === 'number' ? `n${String(part)}` : `s${String(part.length)}:${part}`
  )).join('/')
}

function claimFocus(button: HTMLElement): void {
  button.focus()
}

function moveFocus(button: HTMLElement, direction: -1 | 1): void {
  const tree = button.closest<HTMLElement>('[role="tree"]')
  /* v8 ignore next -- JsonTree attaches expander handlers only beneath its owning role=tree. */
  if (tree === null) return
  const expanders = Array.from(tree.querySelectorAll<HTMLElement>('[data-json-expander]'))
  const current = expanders.indexOf(button)
  /* v8 ignore next -- the current expander is a member of the queried non-empty set. */
  if (current < 0 || expanders.length === 0) return
  const next = (current + direction + expanders.length) % expanders.length
  const nextExpander = expanders[next]
  /* v8 ignore next -- modulo over the non-empty expander set always resolves a member. */
  if (nextExpander !== undefined) claimFocus(nextExpander)
}

function NodeField({
  field,
  expandable,
  onToggle,
}: {
  field: string | undefined
  expandable: boolean
  onToggle: () => void
}) {
  if (field === undefined) return null
  return (
    <span
      className={clsx(css.label, expandable && css.clickableLabel)}
      onClick={expandable ? onToggle : undefined}
    >
      {fieldText(field)}:
    </span>
  )
}

interface JsonTreeNodeProps {
  collapsedStringLines: number
  field?: string
  initialExpanded: boolean
  labels: JsonTreeLabels
  lastElement: boolean
  onClaimTabStop: (id: string) => void
  onRowHover: (row: HTMLElement, target: RowTarget) => void
  path: JsonPath
  renderCopy: ((target: RowTarget, persistent?: boolean) => ReactNode) | undefined
  tabStopId: string | null
  value: unknown
}

function JsonString({
  collapsedStringLines,
  field,
  labels,
  lastElement,
  renderCopy,
  value,
}: {
  collapsedStringLines: number
  field: string | undefined
  labels: JsonTreeLabels
  lastElement: boolean
  renderCopy: ((persistent?: boolean) => ReactNode) | undefined
  value: string
}) {
  const contentsId = useId()
  const contentRef = useRef<HTMLSpanElement>(null)
  const rawRef = useRef<HTMLPreElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [truncated, setTruncated] = useState(false)

  useLayoutEffect(() => {
    if (expanded) return
    const content = contentRef.current as HTMLSpanElement
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight)
      setTruncated(content.scrollHeight > lineHeight * collapsedStringLines)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => { observer.disconnect() }
  }, [collapsedStringLines, expanded, field, lastElement, value])

  useLayoutEffect(() => {
    if (!expanded) return
    const raw = rawRef.current as HTMLPreElement
    const clips: HTMLElement[] = []
    const tree = raw.closest<HTMLElement>(`.${css.root}`) as HTMLElement
    for (let parent = tree.parentElement; parent !== null; parent = parent.parentElement) {
      if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) clips.push(parent)
    }
    const measure = () => {
      let top = 0
      let bottom = window.innerHeight
      for (const clip of clips) {
        const rect = clip.getBoundingClientRect()
        const style = getComputedStyle(clip)
        top = Math.max(top, rect.top + clip.clientTop)
        bottom = Math.min(bottom, rect.top + clip.clientTop + clip.clientHeight
          - Number.parseFloat(style.paddingBottom))
      }
      const available = bottom - Math.max(top, raw.getBoundingClientRect().top)
      raw.style.maxHeight = `${Math.max(16, available - 4)}px`
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(raw)
    for (const clip of clips) observer.observe(clip)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [expanded, value])

  if (expanded) {
    const fieldId = `${contentsId}-field`
    return (
      <div className={css.stringField} data-expanded>
        {field !== undefined && <span id={fieldId} className={css.label}>{fieldText(field)}:</span>}
        <pre
          ref={rawRef}
          id={contentsId}
          className={css.stringRaw}
          tabIndex={0}
          aria-labelledby={field === undefined ? undefined : fieldId}
        >
          {value}
        </pre>
        <div className={css.stringActions}>
          <button
            type="button"
            className={css.actionButton}
            aria-label={labels.collapseNode}
            title={labels.collapseNode}
            aria-expanded
            aria-controls={contentsId}
            onClick={() => { setExpanded(false) }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M9.5 1.5v5h5M1.5 9.5h5v5" />
            </svg>
          </button>
          {renderCopy?.(true)}
        </div>
      </div>
    )
  }

  return (
    <>
      {renderCopy?.()}
      <span className={css.stringField} data-expanded={expanded}>
        <span ref={contentRef} id={contentsId} className={css.stringText}>
          {truncated && (
            <span className={css.stringToggleSlot}>
              <button
                type="button"
                className={css.stringToggle}
                aria-label={labels.expandNode}
                aria-expanded={false}
                aria-controls={contentsId}
                onClick={() => { setExpanded(true) }}
              >
                <span aria-hidden="true">…</span>{labels.expandNode}
              </button>
            </span>
          )}
          {field !== undefined && <span className={css.label}>{fieldText(field)}:</span>}
          {primitiveValue(value)}
          {!lastElement && <span className={css.punctuation}>,</span>}
        </span>
      </span>
    </>
  )
}

function JsonTreeNode({
  collapsedStringLines,
  field,
  initialExpanded,
  labels,
  lastElement,
  onClaimTabStop,
  onRowHover,
  path,
  renderCopy,
  tabStopId,
  value,
}: JsonTreeNodeProps) {
  const contentsId = useId()
  const expanderRef = useRef<HTMLSpanElement>(null)
  const [expanded, setExpanded] = useState(initialExpanded)
  const nodeId = pathId(path)
  const container = isExpandableValue(value)
  const entries = container ? entriesOf(value) : []
  const expandable = entries.length > 0

  const toggle = () => {
    setExpanded(current => !current)
    claimFocus(expanderRef.current as HTMLSpanElement)
  }

  const onExpanderKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      setExpanded(event.key === 'ArrowRight')
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus(event.currentTarget, event.key === 'ArrowUp' ? -1 : 1)
    }
  }

  const row = (children: ReactNode, ariaExpanded?: boolean) => (
    <div
      className={css.row}
      role="treeitem"
      aria-expanded={ariaExpanded}
      onMouseOver={(event) => {
        event.stopPropagation()
        onRowHover(event.currentTarget, { path, value })
      }}
    >
      {typeof value !== 'string' && renderCopy?.({ path, value })}
      {children}
    </div>
  )

  if (typeof value === 'string') {
    return row(
      <JsonString
        collapsedStringLines={collapsedStringLines}
        field={field}
        value={value}
        labels={labels}
        lastElement={lastElement}
        renderCopy={renderCopy === undefined ? undefined : persistent => renderCopy({ path, value }, persistent)}
      />,
    )
  }

  if (!container) {
    return row((
      <>
        <NodeField field={field} expandable={false} onToggle={toggle} />
        {primitiveValue(value)}
        {!lastElement && <span className={css.punctuation}>,</span>}
      </>
    ))
  }

  const [open, close] = bracketOf(value)
  if (!expandable) {
    return row((
      <>
        <NodeField field={field} expandable={false} onToggle={toggle} />
        <span className={css.punctuation}>{open}</span>
        <span className={css.punctuation}>{close}</span>
        {!lastElement && <span className={css.punctuation}>,</span>}
      </>
    ))
  }

  return row((
    <>
      <span
        ref={expanderRef}
        className={clsx(css.expander, expanded ? css.collapseIcon : css.expandIcon)}
        data-json-expander
        role="button"
        aria-label={expanded ? labels.collapseNode : labels.expandNode}
        aria-expanded={expanded}
        aria-controls={expanded ? contentsId : undefined}
        tabIndex={tabStopId === nodeId ? 0 : -1}
        onFocus={() => { onClaimTabStop(nodeId) }}
        onClick={toggle}
        onKeyDown={onExpanderKeyDown}
      />
      <span className={css.summary}>
        <NodeField field={field} expandable onToggle={toggle} />
        <span className={css.preview}>{previewValue(value, 0)}</span>
        {!lastElement && <span className={css.punctuation}>,</span>}
      </span>
      {expanded && (
        <ul id={contentsId} role="group" className={css.children}>
          {entries.map(([key, item], index) => (
            <JsonTreeNode
              key={key}
              collapsedStringLines={collapsedStringLines}
              field={key}
              value={item}
              path={[...path, Array.isArray(value) ? index : key]}
              labels={labels}
              lastElement={index === entries.length - 1}
              initialExpanded={false}
              tabStopId={tabStopId}
              onClaimTabStop={onClaimTabStop}
              onRowHover={onRowHover}
              renderCopy={renderCopy}
            />
          ))}
        </ul>
      )}
    </>
  ), expanded)
}

function formattedPath(path: JsonPath): string {
  return path.reduce<string>((result, part) => {
    if (typeof part === 'number') return `${result}[${String(part)}]`
    return /^[A-Za-z_$][\w$]*$/.test(part)
      ? `${result}.${part}`
      : `${result}[${JSON.stringify(part)}]`
  }, '$')
}

function copyText(target: RowTarget, mode: 'json' | 'path' | 'prettyJson' | 'value'): string {
  if (mode === 'path') return formattedPath(target.path)
  if (mode === 'prettyJson') return JSON.stringify(target.value, null, 2)
  if (mode === 'json') return JSON.stringify(target.value)
  if (typeof target.value === 'string') return target.value
  if (typeof target.value === 'undefined') return 'undefined'
  if (typeof target.value === 'bigint') return target.value.toString()
  if (typeof target.value === 'symbol') return target.value.description ?? 'Symbol'
  if (typeof target.value === 'function') return target.value.name || 'Function'
  return JSON.stringify(target.value)
}

/** Props for the read-only, token-themed JSON tree. */
export interface JsonTreeProps {
  /** Parsed JSON object or array. */
  data: object | unknown[]
  /** Accessible label for the tree. */
  label: string
  /** Optional positioning class owned by the caller. */
  className?: string | undefined
  /** Maximum visible lines per collapsed string; defaults to 3. */
  collapsedStringLines?: number
  /** Whether JSON rows expose copy actions. */
  copyable?: boolean
  /** Whether the top-level object or array is always expanded. */
  expandTopLevel?: boolean
  /** Localized display copy supplied by the owning render site. */
  labels: JsonTreeLabels
}

/**
 * Render parsed JSON as a compact, keyboard-accessible inspector tree.
 * @param props - Parsed data, accessible label, and display options.
 * @returns A read-only JSON tree with an optionally fixed-open top level.
 */
export function JsonTree({
  data,
  label,
  className,
  collapsedStringLines = 3,
  copyable = true,
  expandTopLevel = true,
  labels,
}: JsonTreeProps) {
  const rootEntries = entriesOf(data)
  const firstExpandableIndex = rootEntries.findIndex(([, value]) => (
    isExpandableValue(value) && entriesOf(value).length > 0
  ))
  const firstExpandableEntry = rootEntries[firstExpandableIndex]
  const initialTabStopId = expandTopLevel
    ? firstExpandableEntry === undefined
      ? null
      : pathId([Array.isArray(data) ? firstExpandableIndex : firstExpandableEntry[0]])
    : isExpandableValue(data) && rootEntries.length > 0 ? pathId([]) : null
  const activeRowRef = useRef<HTMLElement>()
  const copyButtonRef = useRef<HTMLButtonElement | null>(null)
  const copyMenuOpenRef = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout>>()
  const [copyTarget, setCopyTarget] = useState<RowTarget>()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)
  const [tabStopId, setTabStopId] = useState<string | null>(initialTabStopId)

  const setActiveRow = (row: HTMLElement | undefined) => {
    activeRowRef.current?.removeAttribute('data-json-copy-active')
    activeRowRef.current = row
    row?.setAttribute('data-json-copy-active', '')
  }

  const clearCopyTarget = () => {
    setActiveRow(undefined)
    setCopyTarget(undefined)
    setCopyState('idle')
    copyMenuOpenRef.current = false
    setCopyMenuOpen(false)
  }

  useEffect(() => () => {
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
    activeRowRef.current?.removeAttribute('data-json-copy-active')
  }, [])

  useEffect(() => {
    activeRowRef.current?.removeAttribute('data-json-copy-active')
    activeRowRef.current = undefined
    copyMenuOpenRef.current = false
    setCopyTarget(undefined)
    setCopyState('idle')
    setCopyMenuOpen(false)
    setTabStopId(initialTabStopId)
  }, [data, expandTopLevel, initialTabStopId])

  const handleRowHover = (row: HTMLElement, target: RowTarget) => {
    if (!copyable || copyMenuOpenRef.current) return
    if (activeRowRef.current === row) return
    setActiveRow(row)
    setCopyState('idle')
    copyMenuOpenRef.current = false
    setCopyMenuOpen(false)
    setCopyTarget(target)
  }

  const handleRootMouseOver = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!copyable || copyMenuOpenRef.current) return
    /* v8 ignore next -- browser mouse events delivered through React target an Element. */
    if (!(event.target instanceof Element)) return
    if (event.target.closest('[data-json-copy-button]') === null) clearCopyTarget()
  }

  const copy = async (target: RowTarget, mode: 'json' | 'path' | 'prettyJson' | 'value') => {
    setCopyTarget(target)
    try {
      await navigator.clipboard.writeText(copyText(target, mode))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => { setCopyState('idle') }, 1_500)
  }

  const [rootOpen, rootClose] = bracketOf(data)
  const renderCopy = copyable ? (target: RowTarget, persistent = false) => {
    const active = copyTarget !== undefined && pathId(copyTarget.path) === pathId(target.path)
    const state = active ? copyState : 'idle'
    const object = typeof target.value === 'object' && target.value !== null
    const copyTitle = state === 'copied'
      ? labels.copied
      : state === 'failed'
        ? labels.copyFailed
        : object ? labels.copyPrettyJson : labels.copyValue
    return (
      <span className={css.copySlot}>
        {(persistent || active) && (
          <Menu
            open={active && copyMenuOpen}
            compact
            portal
            align="end"
            anchor={(
              <button
                type="button"
                className={css.actionButton}
                data-json-copy-button
                data-state={state}
                aria-label={copyTitle}
                title={labels.copyButtonTitle(copyTitle)}
                onClick={() => void copy(target, object ? 'prettyJson' : 'value')}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  copyButtonRef.current = event.currentTarget
                  setCopyTarget(target)
                  copyMenuOpenRef.current = true
                  setCopyMenuOpen(true)
                }}
              >
                {state === 'copied'
                  ? <IconCheckOutline16 size={12} />
                  : <IconCopyOutline16 size={12} />}
              </button>
            )}
            items={object ? objectCopyMenuItems(labels) : valueCopyMenuItems(labels)}
            onSelect={(id) => {
              void copy(target, id as 'json' | 'path' | 'prettyJson' | 'value')
              copyMenuOpenRef.current = false
              setCopyMenuOpen(false)
            }}
            onClose={clearCopyTarget}
            getAnchorRect={() => (
              copyButtonRef.current as HTMLButtonElement
            ).getBoundingClientRect()}
          />
        )}
      </span>
    )
  } : undefined

  return (
    <div
      className={clsx(css.root, className)}
      style={{ '--json-tree-collapsed-lines': collapsedStringLines } as CSSProperties}
      onMouseOver={handleRootMouseOver}
      onMouseLeave={() => {
        if (!copyMenuOpenRef.current) clearCopyTarget()
      }}
    >
      {expandTopLevel
        ? (
          <div className={css.expandedTopLevel}>
            <div
              className={clsx(css.row, css.topLevelBracket)}
              data-json-root-row
              onMouseOver={(event) => {
                event.stopPropagation()
                handleRowHover(event.currentTarget, { path: [], value: data })
              }}
            >
              {renderCopy?.({ path: [], value: data })}
              <span className={css.punctuation}>{rootOpen}</span>
            </div>
            <div
              aria-label={label}
              className={clsx(css.container, css.expandedTopLevelContainer)}
              role="tree"
            >
              {rootEntries.map(([key, value], index) => (
                <JsonTreeNode
                  key={key}
                  collapsedStringLines={collapsedStringLines}
                  field={key}
                  value={value}
                  path={[Array.isArray(data) ? index : key]}
                  labels={labels}
                  lastElement={index === rootEntries.length - 1}
                  initialExpanded={false}
                  tabStopId={tabStopId}
                  onClaimTabStop={setTabStopId}
                  onRowHover={handleRowHover}
                  renderCopy={renderCopy}
                />
              ))}
            </div>
            <div className={clsx(css.row, css.topLevelBracket)}>
              <span className={css.punctuation}>{rootClose}</span>
            </div>
          </div>
        )
        : (
          <div aria-label={label} className={css.container} role="tree">
            <JsonTreeNode
              collapsedStringLines={collapsedStringLines}
              value={data}
              path={[]}
              labels={labels}
              lastElement
              initialExpanded
              tabStopId={tabStopId}
              onClaimTabStop={setTabStopId}
              onRowHover={handleRowHover}
              renderCopy={renderCopy}
            />
          </div>
        )}
    </div>
  )
}
