/** Lazy runtime-object tree with identity links and native disclosure controls. */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { InspectorObjects, InspectorObjectReference } from './objects.ts'
import { InspectorObjectValue, type InspectorObjectEntry } from './object-value.ts'
import css from './inspector.module.css'

/** Original value and Session-local reference navigation. */
export type InspectorObjectTreeProps = PropsLocale<'session-inspector'> & {
  readonly value: unknown
  readonly objects: InspectorObjects
  readonly navigate: (reference: InspectorObjectReference) => void
}

interface BranchProps extends InspectorObjectTreeProps {
  readonly revision: object
  readonly name: string
  readonly path: string
  readonly ancestors: ReadonlyMap<object, string>
  readonly root?: boolean
  readonly accessor?: boolean
  readonly absent?: boolean
}

const PAGE_SIZE = 50

function ObjectBranch({ value, name, path, ancestors, root, accessor, absent, objects, revision, navigate, t }: BranchProps) {
  const [expanded, setExpanded] = useState(root === true)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const content = useMemo(() => {
    try {
      const reference = !root && value !== null && typeof value === 'object' ? objects.reference(value) : undefined
      const circular = value !== null && typeof value === 'object' ? ancestors.get(value) : undefined
      const inline = reference === undefined || reference.kind === 'nodeData'
      const display = inline && circular === undefined && !accessor ? new InspectorObjectValue(value) : undefined
      const entries: InspectorObjectEntry[] = []
      if (expanded && display?.expandable === true) {
        for (const entry of display.entries()) {
          entries.push(entry)
          if (entries.length > limit) break
        }
      }
      return { reference, circular, display, entries, error: undefined }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [value, root, objects, ancestors, accessor, expanded, limit, revision])
  const children = useMemo(() => {
    const next = new Map(ancestors)
    if (value !== null && typeof value === 'object') next.set(value, path)
    return next
  }, [ancestors, value, path])
  const field = <span className={css.objectField}>{name}: </span>
  if (content.error !== undefined) return <li role="alert">{field}{content.error}</li>
  if (absent) return <li>{field}<span className={css.objectMuted}>{t('object.absent')}</span></li>
  if (accessor) return <li>{field}<span className={css.objectMuted}>{t('object.accessor')}</span></li>
  const reference = content.reference
  const link = reference === undefined ? undefined : <button type="button" className={css.objectReference}
    onClick={(event) => { event.preventDefault(); event.stopPropagation(); navigate(reference) }}>
    ↗ {t(`object.${reference.kind}`)} · {reference.identity}
  </button>
  if (reference !== undefined && (reference.kind !== 'nodeData' || content.circular !== undefined)) return <li>{field}{link}</li>
  if (content.circular !== undefined) return <li>{field}<span className={css.objectMuted}>↩ {content.circular}</span></li>
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Accessors, references, cycles, and read errors return above.
  const display = content.display!
  if (!display.expandable) return <li>{field}<span className={css.objectValue}>{display.label}</span></li>
  return <li><details open={expanded} onToggle={(event) => { setExpanded(event.currentTarget.open) }}>
    <summary>{field}{link} <span className={css.objectMuted}>{display.label}</span></summary>
    {expanded && <ul>
      {content.entries.slice(0, limit).map(({ key, properties, ...entry }) => <ObjectBranch key={key} {...entry}
        name={properties ? t('object.properties') : entry.name}
        path={properties ? path : `${path}.${entry.name}`} ancestors={children} objects={objects} revision={revision} navigate={navigate} t={t} />)}
      {content.entries.length === 0 && <li className={css.objectMuted}>{t('object.empty')}</li>}
      {content.entries.length > limit && <li><button type="button" className={css.objectReference}
        onClick={() => { setLimit(value => value + PAGE_SIZE) }}>{t('object.more')}</button></li>}
    </ul>}
  </details></li>
}

/**
 * Inspect the root and nested Node Data inline; other registered objects remain navigation links.
 * Node Data titles also navigate, while repeated ancestors never expand recursively.
 * Expanded fields are cached until their value or Conversation publication changes.
 * @param props - Original object, weak identity lookup, locale, and reference activation.
 * @returns A lazily expanded, typed tree that retains Map keys and collection identities.
 */
export function InspectorObjectTree(props: InspectorObjectTreeProps) {
  const updates = props.objects.updates
  const subscribe = useCallback((listener: () => void) => updates.subscribe(listener), [updates])
  const getRevision = useCallback(() => updates.getSnapshot(), [updates])
  const revision = useSyncExternalStore(subscribe, getRevision)
  const ancestors = useMemo(() => new Map<object, string>(), [])
  return <ul className={css.objectTree}><ObjectBranch {...props} revision={revision} name="$" path="$" ancestors={ancestors} root /></ul>
}
