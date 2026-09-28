/**
 * Compact field list for a Markdown document's leading YAML frontmatter. The
 * Markdown body loads this module lazily so the YAML parser stays out of the
 * startup chunk.
 */
import { useMemo, type ReactNode } from 'react'
import { parseDocument, stringify } from 'yaml'
import css from './frontmatter-fields.module.css'

/** One top-level entry; `block` marks the YAML source of a collection value. */
interface FrontmatterField {
  key: string
  value: string
  block: boolean
}

/**
 * Resolve top-level mapping fields.
 * @param source - YAML between the frontmatter delimiters.
 * @returns the fields, or `undefined` for invalid YAML and non-mapping documents.
 */
function parseFields(source: string): readonly FrontmatterField[] | undefined {
  const parsed = parseDocument(source)
  if (parsed.errors.length > 0) return undefined
  let data: unknown
  try {
    data = parsed.toJS()
  } catch {
    // `toJS` rejects excessive alias expansion; the preview shows the source instead of the reason.
    return undefined
  }
  if (data === null) return []
  if (typeof data !== 'object' || Array.isArray(data)) return undefined
  return Object.entries(data).map(([key, value]) => fieldOf(key, value))
}

function fieldOf(key: string, value: unknown): FrontmatterField {
  if (value === null) return { key, value: '', block: false }
  // Core-schema scalars are strings, numbers, and booleans; collections render as YAML source.
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { key, value: String(value), block: false }
  }
  return { key, value: stringify(value).trimEnd(), block: true }
}

/**
 * Render frontmatter fields, or the verbatim source when it is not a YAML mapping.
 * @param props - YAML between the frontmatter delimiters.
 * @returns the metadata block shown above the Markdown body, or nothing for an empty block.
 */
export function FrontmatterBlock({ source }: { source: string }): ReactNode {
  const fields = useMemo(() => parseFields(source), [source])
  if (fields === undefined) return <pre className={css.frontmatter} data-document-frontmatter>{source}</pre>
  if (fields.length === 0) return null
  return (
    <dl className={css.frontmatter} data-document-frontmatter>
      {fields.map(field => (
        <div key={field.key} className={css.field}>
          <dt className={css.key}>{field.key}</dt>
          <dd className={field.block ? css.block : css.value}>{field.value}</dd>
        </div>
      ))}
    </dl>
  )
}
