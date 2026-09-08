/**
 * What the probe's child process reports, and the check the parent runs on
 * it. The report crosses a process boundary as an IPC message, so the parent
 * validates every field before trusting it; the child only imports the
 * types.
 * @module @deepseek-ai/dsh-app-boot/probe-report
 */

/** What importing one module in the child found. */
export interface ChildInspection {
  /** Whether the import succeeded. */
  ok: boolean
  /** Whether the module's default or namespace export is a cordis plugin. */
  isPlugin: boolean
  /** The plugin's `Config.toJSON()`, or null when it declares none. */
  configSchema: unknown
  /** The import failure, when `ok` is false. */
  error?: string
}

/** The child's one message: where cordis resolves from the package, and what each module imported as. */
export interface ChildReport {
  /** The token the parent handed the child for this run; a message without it is not the report. */
  token: string
  /** The URL the package resolves `@deepseek-ai/cordis` to, or null when it does not resolve it. */
  cordis: string | null
  /** The main export's inspection; the not-imported default when the package declares no main. */
  main: ChildInspection
  /** The inspection of each declared addable module, by its specifier. */
  addable: Record<string, ChildInspection>
}

/**
 * Whether a value is a plain object: the only JSON value with named fields.
 * @param value - the value to test.
 * @returns true for a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value has the fields of one inspection. */
function isInspection(value: unknown): value is ChildInspection {
  return isRecord(value)
    && typeof value.ok === 'boolean'
    && typeof value.isPlugin === 'boolean'
    && 'configSchema' in value
    && (value.error === undefined || typeof value.error === 'string')
}

/**
 * Validate a message the child sent as its report.
 * @param value - the message as received.
 * @returns the report, or undefined when the message is not one.
 */
export function parseChildReport(value: unknown): ChildReport | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.token !== 'string') return undefined
  if (value.cordis !== null && typeof value.cordis !== 'string') return undefined
  if (!isInspection(value.main) || !isRecord(value.addable)) return undefined
  if (!Object.values(value.addable).every(isInspection)) return undefined
  return value as unknown as ChildReport
}
