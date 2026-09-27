/**
 * Lazily scanned view of one JSON object's top-level fields, built from text
 * that may still be streaming or from an already parsed object. Nothing is
 * scanned until a reader asks; the view remembers every question it answered
 * and, when more text arrives, reports a change only if one of those answers
 * would differ. Used for model tool-call arguments: a row reads the fields it
 * cares about at whatever granularity it displays, at every stage of the call.
 * @module @deepseek-ai/dsh-util-values/src/partial-json
 */
import { assertNever, type JsonValue } from './index.ts'

/** Granularity of a length read; a change is reported only when the rounded-up step moves. */
export interface LengthReadOptions {
  /** Characters per step; defaults to 1 (every character counts). */
  readonly step?: number
  /** Completed characters included in the displayed total; affects change detection only. */
  readonly offset?: number
}

/** Scanner position inside the object text. */
type Mode =
  | 'root' | 'key-or-end' | 'key-only' | 'key' | 'colon' | 'value'
  | 'string' | 'scalar' | 'nested' | 'comma-or-end' | 'closed' | 'invalid'

/** One top-level field located in the text: a string with its decoded progress, or another value. */
type Entry =
  | { readonly kind: 'string'; readonly start: number; end: number; length: number; text: string | undefined }
  | { readonly kind: 'value'; readonly start: number; end: number; parsed: JsonValue | undefined }

type ReadKind = 'closed' | 'keys' | 'has' | 'complete' | 'text' | 'value' | `length:${number}:${number}`

/** One answered question, kept to detect whether later text changes the answer. */
interface Read {
  readonly answer: (view: PartialArguments) => unknown
  last: unknown
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
}

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\r' || c === '\t'
}

function isHex(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

/**
 * Decode an already scanned JSON string body. The caller cuts the body before any
 * escape still in flight, so a trailing `\\` or an unknown escape only appears
 * after the scan failed there; decoding stops at that point.
 */
function decodeStringPrefix(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string
    if (c < ' ') break
    if (c !== '\\') { out += c; continue }
    const e = body[i + 1]
    if (e === undefined) break
    if (e === 'u') {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 2, i + 6), 16))
      i += 5
      continue
    }
    const decoded = SIMPLE_ESCAPES[e]
    if (decoded === undefined) break
    out += decoded
    i += 1
  }
  return out
}

/**
 * The view. A streaming instance grows through {@link PartialArguments.append};
 * {@link PartialArguments.fromText} and {@link PartialArguments.fromObject} build
 * sealed instances over a finished call. Every reader is total: an absent or
 * differently typed field answers `undefined` (or `false`), never throws.
 */
export class PartialArguments {
  /** The view of a call with no arguments available. */
  static readonly EMPTY: PartialArguments = PartialArguments.fromObject({})

  /**
   * View finished argument text without scanning it until a reader asks.
   * @param text - the complete argument JSON text.
   * @returns a sealed view.
   */
  static fromText(text: string): PartialArguments {
    const view = new PartialArguments()
    view.append(text)
    view.sealed = true
    return view
  }

  /**
   * View an already parsed argument payload, such as a PTC dispatch object.
   * @param value - the parsed argument value.
   * @returns a sealed view; a non-object payload has no fields.
   */
  static fromObject(value: unknown): PartialArguments {
    const view = new PartialArguments()
    view.object = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, JsonValue>>
      : {}
    view.sealed = true
    return view
  }

  /**
   * The source: text so far or a parsed object, plus whether it can still grow.
   * These are the only enumerable fields, so two views over the same source
   * compare equal structurally however far each has been read.
   */
  private raw = ''
  private object: Readonly<Record<string, JsonValue>> | undefined
  private sealed = false
  // Scan progress, located fields, and remembered reads are caches over the source.
  #pending = ''
  #consumed = 0
  #mode: Mode = 'root'
  #escape = false
  #unicode: string | null = null
  #keyRaw = ''
  #key = ''
  #current: Entry | null = null
  #nestedDepth = 0
  #nestedInString = false
  readonly #entries = new Map<string, Entry>()
  readonly #order: string[] = []
  readonly #reads = new Map<string, Read>()

  /** Whether the text stopped being a JSON object prefix; scanning stops there and answers freeze. */
  get invalid(): boolean {
    this.scan()
    return this.#mode === 'invalid'
  }

  /**
   * Append streamed argument text.
   * @param fragment - the text following every fragment appended before.
   * @returns whether the answer to a question already asked would now differ; false when nothing was read yet.
   */
  append(fragment: string): boolean {
    if (this.sealed) throw new Error('PartialArguments: cannot append to a sealed view')
    this.raw += fragment
    this.#pending += fragment
    if (this.#reads.size === 0) return false
    this.scan()
    let changed = false
    for (const read of this.#reads.values()) {
      const now = read.answer(this)
      if (!Object.is(now, read.last)) {
        read.last = now
        changed = true
      }
    }
    return changed
  }

  /**
   * Check whether no further fields can arrive.
   * @returns whether no further field can appear: the object closed, the text stopped being JSON, or the view is sealed.
   */
  closed(): boolean {
    return this.remember('closed', '', view => view.closedNow(), () => this.closedNow())
  }

  /**
   * List discovered fields in first-appearance order.
   * @returns top-level keys seen so far, in first-appearance order.
   */
  keys(): readonly string[] {
    return this.remember('keys', '', view => view.keysNow().length, () => this.keysNow())
  }

  /**
   * Check whether a top-level field has appeared.
   * @param key - argument name.
   * @returns whether the field has appeared (a string opened or another value began).
   */
  has(key: string): boolean {
    return this.remember('has', key, view => view.hasNow(key), () => this.hasNow(key))
  }

  /**
   * Check whether a field's value is complete.
   * @param key - argument name.
   * @returns whether the field's value is final: a closed string or a closed other value.
   */
  complete(key: string): boolean {
    return this.remember('complete', key, view => view.completeNow(key), () => this.completeNow(key))
  }

  /**
   * Read string length without materializing its text.
   * @param key - argument name.
   * @param options - change granularity for a streaming string.
   * @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
   */
  stringLength(key: string, options?: LengthReadOptions): number | undefined {
    const step = Math.max(1, Math.floor(options?.step ?? 1))
    const offset = options?.offset ?? 0
    return this.remember(`length:${step}:${offset}`, key, (view) => {
      const length = view.lengthNow(key)
      return length === undefined ? undefined : Math.ceil((length + offset) / step)
    }, () => this.lengthNow(key))
  }

  /**
   * Read a decoded string, including a streaming prefix.
   * @param key - argument name.
   * @returns the string field's decoded text so far; undefined when absent or not a string.
   */
  text(key: string): string | undefined {
    return this.remember('text', key, view => view.textNow(key), () => this.textNow(key))
  }

  /**
   * Read a completed non-string argument.
   * @param key - argument name.
   * @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
   */
  value(key: string): JsonValue | undefined {
    return this.remember('value', key, view => view.valueNow(key), () => this.valueNow(key))
  }

  /** Answer a question and, on a streaming view, remember it for change detection. */
  private remember<T>(kind: ReadKind, key: string, answer: (view: PartialArguments) => unknown, read: () => T): T {
    this.scan()
    const result = read()
    if (!this.sealed) {
      const id = `${kind}/${key}`
      const existing = this.#reads.get(id)
      if (existing === undefined) this.#reads.set(id, { answer, last: answer(this) })
      else existing.last = answer(this)
    }
    return result
  }

  private closedNow(): boolean {
    return this.sealed || this.#mode === 'closed' || this.#mode === 'invalid'
  }

  private keysNow(): readonly string[] {
    return this.object === undefined ? this.#order : Object.keys(this.object)
  }

  private hasNow(key: string): boolean {
    return this.object === undefined ? this.#entries.has(key) : Object.hasOwn(this.object, key)
  }

  private completeNow(key: string): boolean {
    if (this.object !== undefined) return Object.hasOwn(this.object, key)
    const entry = this.#entries.get(key)
    return entry !== undefined && entry.end >= 0
  }

  private lengthNow(key: string): number | undefined {
    if (this.object !== undefined) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : undefined
      return typeof field === 'string' ? field.length : undefined
    }
    const entry = this.#entries.get(key)
    return entry?.kind === 'string' ? entry.length : undefined
  }

  private textNow(key: string): string | undefined {
    if (this.object !== undefined) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : undefined
      return typeof field === 'string' ? field : undefined
    }
    const entry = this.#entries.get(key)
    if (entry?.kind !== 'string') return undefined
    if (entry.text === undefined) {
      // First text read: decode what streamed so far; scanning keeps it current from here on.
      entry.text = entry.end >= 0
        ? JSON.parse(`"${this.raw.slice(entry.start, entry.end)}"`) as string
        : decodeStringPrefix(this.raw.slice(entry.start, this.openStringEnd()))
    }
    return entry.text
  }

  /** Where the decoded prefix of the string being read ends: before any escape still in flight. */
  private openStringEnd(): number {
    if (this.#unicode !== null) return this.#consumed - 2 - this.#unicode.length
    return this.#escape ? this.#consumed - 1 : this.#consumed
  }

  private valueNow(key: string): JsonValue | undefined {
    if (this.object !== undefined) {
      if (!Object.hasOwn(this.object, key)) return undefined
      const field = this.object[key]
      return typeof field === 'string' ? undefined : field
    }
    const entry = this.#entries.get(key)
    return entry?.kind === 'value' && entry.end >= 0 ? entry.parsed : undefined
  }

  /** Index only unread text; indexing accumulated raw text repeatedly flattens its prefix. */
  private scan(): void {
    if (this.object !== undefined) return
    const pending = this.#pending
    this.#pending = ''
    for (let index = 0; index < pending.length && this.#mode !== 'invalid'; index++) {
      this.step(pending[index] as string, this.#consumed)
      this.#consumed++
    }
  }

  private step(c: string, at: number): void {
    switch (this.#mode) {
      case 'root':
        if (isWhitespace(c)) return
        if (c === '{') { this.#mode = 'key-or-end'; return }
        this.fail(); return
      case 'key-or-end':
        if (isWhitespace(c)) return
        if (c === '}') { this.#mode = 'closed'; return }
        if (c === '"') { this.beginKey(); return }
        this.fail(); return
      case 'key-only':
        if (isWhitespace(c)) return
        if (c === '"') { this.beginKey(); return }
        this.fail(); return
      case 'key':
        this.stepKey(c); return
      case 'colon':
        if (isWhitespace(c)) return
        if (c === ':') { this.#mode = 'value'; return }
        this.fail(); return
      case 'value':
        this.beginValue(c, at); return
      case 'string':
        this.stepString(c, at); return
      case 'scalar':
        this.stepScalar(c, at); return
      case 'nested':
        this.stepNested(c, at); return
      case 'comma-or-end':
        if (isWhitespace(c)) return
        if (c === ',') { this.#mode = 'key-only'; return }
        if (c === '}') { this.#mode = 'closed'; return }
        this.fail(); return
      case 'closed':
        if (isWhitespace(c)) return
        this.fail(); return
      /* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
      case 'invalid':
        return
      /* v8 ignore next 2 -- Every scanner mode has a handler above. */
      default:
        assertNever(this.#mode)
    }
  }

  private fail(): void {
    this.#mode = 'invalid'
    this.#current = null
  }

  private beginKey(): void {
    this.#mode = 'key'
    this.#keyRaw = ''
    this.#escape = false
  }

  private stepKey(c: string): void {
    if (this.#escape) { this.#escape = false; this.#keyRaw += c; return }
    if (c === '\\') { this.#escape = true; this.#keyRaw += c; return }
    if (c !== '"') { this.#keyRaw += c; return }
    let key: unknown
    try {
      key = JSON.parse(`"${this.#keyRaw}"`)
    } catch {
      // The key text is not a valid JSON string: the object text is not a JSON prefix.
      this.fail()
      return
    }
    this.#key = key as string
    this.#mode = 'colon'
  }

  private open(entry: Entry): void {
    if (!this.#entries.has(this.#key)) this.#order.push(this.#key)
    this.#entries.set(this.#key, entry)
    this.#current = entry
  }

  private beginValue(c: string, at: number): void {
    if (isWhitespace(c)) return
    if (c === '"') {
      this.open({ kind: 'string', start: at + 1, end: -1, length: 0, text: undefined })
      this.#escape = false
      this.#unicode = null
      this.#mode = 'string'
      return
    }
    if (c === '}' || c === ',' || c === ':' || c === ']') { this.fail(); return }
    this.open({ kind: 'value', start: at, end: -1, parsed: undefined })
    if (c === '{' || c === '[') {
      this.#mode = 'nested'
      this.#nestedDepth = 1
      this.#nestedInString = false
      this.#escape = false
      return
    }
    this.#mode = 'scalar'
  }

  private stepString(c: string, at: number): void {
    const entry = this.#current as Extract<Entry, { kind: 'string' }>
    if (c < ' ') { this.fail(); return }
    if (this.#unicode !== null) {
      if (!isHex(c)) { this.fail(); return }
      this.#unicode += c
      if (this.#unicode.length === 4) {
        this.grow(entry, String.fromCharCode(Number.parseInt(this.#unicode, 16)))
        this.#unicode = null
      }
      return
    }
    if (this.#escape) {
      this.#escape = false
      if (c === 'u') { this.#unicode = ''; return }
      const decoded = SIMPLE_ESCAPES[c]
      if (decoded === undefined) { this.fail(); return }
      this.grow(entry, decoded)
      return
    }
    if (c === '\\') { this.#escape = true; return }
    if (c === '"') {
      entry.end = at
      this.#current = null
      this.#mode = 'comma-or-end'
      return
    }
    this.grow(entry, c)
  }

  /** Count one decoded unit and keep the text current when a reader asked for it. */
  private grow(entry: Extract<Entry, { kind: 'string' }>, decoded: string): void {
    entry.length += decoded.length
    if (entry.text !== undefined) entry.text += decoded
  }

  private stepScalar(c: string, at: number): void {
    if (c !== ',' && c !== '}' && !isWhitespace(c)) return
    if (!this.closeValue(at - 1)) return
    this.#mode = c === ',' ? 'key-only' : c === '}' ? 'closed' : 'comma-or-end'
  }

  private stepNested(c: string, at: number): void {
    if (this.#nestedInString) {
      if (this.#escape) { this.#escape = false; return }
      if (c === '\\') { this.#escape = true; return }
      if (c === '"') this.#nestedInString = false
      return
    }
    if (c === '"') { this.#nestedInString = true; return }
    if (c === '{' || c === '[') { this.#nestedDepth++; return }
    if (c === '}' || c === ']') {
      this.#nestedDepth--
      if (this.#nestedDepth === 0 && this.closeValue(at)) this.#mode = 'comma-or-end'
    }
  }

  /** Close the non-string value ending at `end`; text that is not JSON freezes the view. */
  private closeValue(end: number): boolean {
    const entry = this.#current as Extract<Entry, { kind: 'value' }>
    try {
      entry.parsed = JSON.parse(this.raw.slice(entry.start, end + 1)) as JsonValue
    } catch {
      // A number or literal that is not JSON (`tru`, `1.`): the object text is not a JSON prefix.
      this.fail()
      return false
    }
    entry.end = end
    this.#current = null
    return true
  }
}
