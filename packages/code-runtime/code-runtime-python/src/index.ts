/**
 * CPython subprocess code runtime: a fresh `python3` process runs each model program under an
 * asyncio event loop with top-level ``await``. Binding calls travel on fd 3 as JSON-lines,
 * leaving stdout/stderr free for the program's own output. This is containment, not a security
 * boundary: model code has bash-equivalent trust, contained by an empty environment, RLIMIT_CPU
 * + RLIMIT_AS, wall-clock timeout, and SIGTERM→grace→SIGKILL on the process group.
 *
 * The package owns the versionless fd-3 wire protocol between the Node host and
 * the CPython subprocess. The protocol's host-side codec and hostile-frame
 * validators are re-exported so every consumer of the wire shares one
 * vocabulary.
 * @module @deepseek-ai/dsh-code-runtime-python
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { accessSync, copyFileSync, constants as fsConstants, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Duplex } from 'node:stream'
import { Context } from 'cordis'
import z from 'schemastery'
import { CodeRuntime, DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-code-runtime'
import type { CodeBindingErrorClass, CodeBindingFunction, CodeJsonValue, CodeRunFailure, CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { BootMessage, ChildToHost, ReplyMessage } from './protocol.ts'
import { checkDoneValue, encodeJsonPlain, hasUnsafeIntegerToken, logTruncationMarker, validateChildFrame } from './protocol.ts'

// Re-export the fd-3 wire vocabulary so the runtime and its tests share one
// import surface; the protocol layer owns the definitions.
export type { BootMessage, ChildToHost, ReplyMessage } from './protocol.ts'
export {
  checkDoneValue,
  encodeJsonPlain,
  hasNonLosslessNumber,
  hasUnsafeIntegerToken,
  logTruncationMarker,
  validateChildFrame,
} from './protocol.ts'

/** Plugin config: every cap, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /**
   * RLIMIT_CPU in whole seconds (a positive integer — `setrlimit` in the child
   * rejects a float). The child sets the soft limit to `cpuSeconds` and the
   * hard limit to `cpuSeconds + 1`: the kernel delivers SIGXCPU at the soft
   * limit, which the host classifies as a `timeout`; the +1s hard limit is a
   * SIGKILL backstop for a program that traps SIGXCPU. Granularity is seconds —
   * a coarser counterpart to the worker backend's millisecond `computeMs`.
   */
  cpuSeconds?: number
  /** Wall-clock ceiling in milliseconds; backstops CPU time for programs awaiting a promise nobody resolves. */
  maxWallMs?: number
  /**
   * RLIMIT_AS in mebibytes; caps address space so a runaway allocation fails
   * cleanly. Not applied on Darwin, where the dyld shared cache mapped into
   * every process at exec exceeds any practical cap and the kernel rejects
   * the call; `cpuSeconds` and `maxWallMs` still bound the run there.
   */
  addressSpaceMb?: number
  /** Shared byte budget for captured log text (host-side ledger). */
  maxLogBytes?: number
  /** Byte cap for the completion value. */
  maxValueBytes?: number
  /** SIGTERM→SIGKILL grace period on kill, matching bash-local's default. */
  graceMs?: number
  /**
   * Absolute path or basename of the CPython interpreter to spawn. Resolved
   * through `PATH` when a basename is given.
   */
  pythonBin?: string
}

/** {@link Config} with all defaults filled. */
type ResolvedConfig = Required<Config>

/**
 * The seam's language-portable identifier subset (see
 * `CodeBindingNamespace.global`) — identical to Python's identifier grammar,
 * so the shared contract needs no per-backend mapping here.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The seam's cross-language reserved-word union: the portable-identifier
 * contract promises a namespace list valid here is valid on every backend, so
 * a JS keyword like `typeof` is refused even though it is a legal Python name.
 */
const RESERVED_NAMES = PORTABLE_RESERVED_WORDS

/**
 * The seam's shared backend-owned globals (`console` is the worker's slot;
 * `__dsh_main__`/`__builtins__`/`__name__` are this bootstrap's wrapper and
 * seeded module globals). Shared so a namespace list valid on one backend is
 * valid on all — colliding with an owned slot would be silently overwritten
 * (or overwrite builtins), so the seam rejects them up front.
 */
const RUNTIME_OWNED_GLOBALS = RESERVED_BINDING_GLOBALS

/**
 * The seam's shared error-member exclusions (`RESERVED_ERROR_MEMBERS` +
 * dunder-form names) — enforced identically here and in the worker backend so
 * an errorClass valid on one backend is valid on all. Several dunders are
 * constrained CPython descriptors whose `setattr` raises while constructing
 * the very rejection it was meant to carry; the exact set is an interpreter
 * version detail, hence the dunder-wide rule at the seam.
 */
const EXCEPTION_RESERVED_MEMBERS = RESERVED_ERROR_MEMBERS

const DUNDER = DUNDER_MEMBER

/**
 * The `py/` scripts the interpreter must be able to open: the entry script plus
 * every module it imports from its own directory. Kept beside the built JS so a
 * consumer package with `files: ['lib', 'py']` ships both.
 */
const PY_SCRIPTS = ['bootstrap.py', 'protocol.py']

/**
 * Copy the `py/` scripts to a real filesystem directory and return the entry
 * script's path there.
 *
 * The interpreter is an EXTERNAL process, so it can only open paths the OS
 * resolves. Inside the single-file Python-SDK executable, `import.meta.url`
 * resolves into pkg's virtual filesystem, which Node reads through its patched
 * `fs` but `python3` cannot see at all — the spawn fails with ENOENT on a path
 * that exists as far as the host is concerned. `bootstrap.py` additionally
 * inserts its own directory on `sys.path` to import the sibling `protocol.py`,
 * so both files must land in the SAME real directory.
 *
 * The copy is unconditional rather than gated on a bundled-runtime probe: the
 * read goes through Node's `fs` either way, and one code path means the
 * packaged deployment runs what the tests exercise. Placement is under
 * `os.tmpdir()` with `0o700` keeps the scripts off other users' reach, but NOT
 * the model's: the child runs as the same UID as the host, so a program can
 * rewrite the very files it was started from. Hence one copy per RUN, discarded
 * at settlement — a rewrite then damages only the run that performed it, which
 * is what fresh-subprocess-per-run already promises. Sharing one copy across
 * runs made an overwritten `bootstrap.py` break the next run.
 *
 * Deliberately SYNCHRONOUS. An `await` here would open an async boundary in
 * `execute` before the run is registered in `live` and before the abort
 * listener is installed, so a disposal or an abort landing in that window would
 * be missed: `teardown` would see no runs and return while the continuation
 * went on to spawn a subprocess, and an `addEventListener('abort')` installed
 * afterwards does not replay an event that already fired. Three small
 * filesystem operations per run are not worth that class of race, and `execute`
 * already runs synchronously up to `spawn`.
 *
 * A failed copy removes the directory here, so a partial attempt never outlives
 * the call that made it; a successful one is the caller's to remove, which it
 * derives from the returned path.
 *
 * @returns the absolute path of the materialized entry script.
 */
function materializePyScripts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-code-runtime-python-'))
  const source = fileURLToPath(new URL('../py/', import.meta.url))
  try {
    for (const name of PY_SCRIPTS) copyFileSync(join(source, name), join(dir, name))
  } catch (error: unknown) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Swallows only a failure to remove the partial staging directory. The
      // caller reports the copy failure that got us here, which is the
      // diagnosable one; nothing else can act on a temp dir we cannot unlink.
    }
    throw error
  }
  return join(dir, 'bootstrap.py')
}

/**
 * The fd-3 receive ceiling for one unframed line: a pure host-memory-safety
 * bound, NOT an output budget. Binding `call` frames legitimately carry large
 * arguments (the seam puts no byte cap on binding traffic), so the ceiling
 * must sit far above any plausible frame while still stopping a hostile
 * newline-free flood from growing the host accumulator without bound — the
 * child's RLIMIT_AS bounds the child, not the host string. 256 MiB mirrors
 * the order of the worker backend's default outer-output cap and V8's string
 * ceiling neighborhood; completion values have their own `maxValueBytes`
 * check at the `done` handler, deliberately decoupled from this. Not a config
 * knob because it is an internal framing invariant, not a deployment choice.
 */
const FRAME_CEILING_BYTES = 256 * 1024 * 1024

/**
 * Fragments the unframed fd-3 buffer may hold before they are coalesced into
 * one Buffer, bounding retained per-chunk overhead that {@link
 * FRAME_CEILING_BYTES} cannot see: that ceiling meters payload bytes, while
 * each chunk is a distinct Buffer with its own object and backing store. A
 * program writing single bytes without a newline produced one chunk per write.
 * 1024 keeps the overhead a small constant factor of the payload while leaving
 * normal pipe-sized reads (which arrive in far fewer, much larger chunks)
 * untouched. A framing invariant, not a deployment choice.
 */
const MAX_PENDING_CHUNKS = 1024

/**
 * Bytes a frame spends on its own JSON structure around a capped payload, used
 * to bound `maxLogBytes`/`maxValueBytes` against {@link FRAME_CEILING_BYTES}.
 * The widest carrier is `{"type":"log","text":"","truncated":true}` at 41
 * bytes; 64 rounds that up so adding a field to either frame does not silently
 * invalidate the bound. A protocol constant, not a deployment choice.
 */
const FRAME_ENVELOPE_BYTES = 64

/**
 * Extra time added to `graceMs` before the post-kill close-deadline force-settles
 * a run whose `close` never fires (a setsid-escaped orphan holds our inherited
 * stdio; see the `closeDeadline` arm in {@link PythonCodeRuntime.execute}). It
 * covers the OS reaping the killed child itself after SIGKILL — not a deployment
 * choice but a fixed safety margin, so it is a constant rather than a config knob.
 */
const CLOSE_REAP_MARGIN_MS = 2_000

/**
 * Interval between process-group liveness probes while settlement waits for an
 * escalated SIGKILL to empty the group (see the `killing` branch in
 * {@link PythonCodeRuntime.execute}'s settle). A poll rather than an event
 * because the group members are the model's own descendants, which the host does
 * not `wait()` for and gets no exit signal from; the probe is a signal-0
 * `process.kill(-pid, 0)`, so the interval only bounds how promptly a now-empty
 * group is noticed, capped by `graceMs + CLOSE_REAP_MARGIN_MS`.
 */
const GROUP_REAP_POLL_MS = 50

/**
 * Extract a human message from an unknown thrown value.
 *
 * `String(error)` runs the value's own conversion, and a host binding may reject
 * with an object whose `Symbol.toPrimitive` or `toString` throws. One call site
 * is a detached async reply callback, where that throw escapes as an unhandled
 * rejection: the reply frame is never written, the program stays blocked on
 * `await`, and the run degrades to a `maxWallMs` timeout (a Node host without an
 * `unhandledRejection` listener exits outright). The conversion is therefore
 * wrapped, with a fixed literal as the fallback — the value already proved it
 * cannot be rendered, so nothing derived from it is safe to try.
 *
 * `Error.message` is typed `string` but is a plain writable property, so a
 * rejecting binding can hand back an `Error` carrying any value there. The
 * `Error` arm therefore goes through the same conversion rather than returning
 * `message` verbatim: the returned string crosses the wire under
 * `encodeJsonPlain`'s JSON-plain precondition, where a cyclic object grows the
 * encoder stack until the host exhausts memory and any other unsupported value
 * prevents the reply frame outright.
 *
 * The same conversion renders abort reasons, which reach an `AbortSignal`
 * listener: Node reports a throw from such a listener as an uncaught exception,
 * so an unwrapped conversion there can terminate the host with the run left
 * unsettled.
 *
 * @param error The thrown value, of unknown shape.
 * @returns The value's message or string form; a fixed placeholder when its own
 *   conversion throws.
 */
function messageOf(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    // Swallows only a throw from the value's own `message` getter or string
    // conversion. Nothing else runs inside the try, and the placeholder is a
    // literal, so this cannot throw again.
    return '<unrenderable rejection value>'
  }
}

/**
 * Resolve `pythonBin` to an absolute path against the CURRENT process `PATH`,
 * BEFORE the child spawns with an empty environment. A basename (the default
 * `python3`) would otherwise fail: `env: {}` drops `PATH`, so Node's own lookup
 * falls back to the platform default (`/usr/bin:/bin`) and misses interpreters
 * that live only on the caller's `PATH` (Nix, pyenv, Homebrew, conda). An
 * absolute or explicitly relative path is used verbatim. When no `PATH` entry
 * holds an executable match, the original value is returned unchanged so the
 * spawn produces its normal ENOENT `error` event (a settled `worker-exit`),
 * not a thrown exception here.
 * @param bin - the configured interpreter (absolute path or bare command).
 * @returns an absolute path when resolvable, else `bin` unchanged.
 */
function resolvePythonBin(bin: string): string {
  if (isAbsolute(bin) || bin.includes('/')) return bin
  const path = process.env.PATH
  /* v8 ignore next -- PATH is set in every environment the runtime boots in; the guard is defensive. */
  if (path === undefined) return bin
  for (const dir of path.split(delimiter)) {
    // An empty PATH segment (a `::`, implicitly CWD on POSIX) is skipped so a
    // basename never resolves against the working directory; normal PATHs
    // carry no empty segment.
    /* v8 ignore next -- normal PATHs carry no empty segment. */
    if (dir === '') continue
    const candidate = join(dir, bin)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Not executable here; try the next PATH entry.
    }
  }
  return bin
}

/** The marker appended when a diagnostic message is byte-capped host-side. */
const TRUNCATION_MARKER = '… [truncated]'

/**
 * The marker's own UTF-8 byte length, reserved out of the budget so a capped
 * message stays WITHIN `maxValueBytes` rather than exceeding it by the marker.
 * The ellipsis is 3 bytes, so this is 15, not the string's 13 code units.
 */
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')

/**
 * Cap a done-frame `error.message` to `maxValueBytes` host-side: a forged done
 * frame can carry an arbitrarily long message, so truncate by byte length and
 * append the shared marker on overflow. Completion VALUES are never truncated
 * — the seam forbids substitution, so an oversized value fails the run as
 * `output-limit` instead (see the done case in `execute`).
 *
 * The marker's bytes are RESERVED from the budget, not added on top: the whole
 * returned string, marker included, is at most `maxValueBytes` bytes. Appending
 * the marker after retaining a full budget's worth of text would overrun the
 * very cap this function exists to enforce. The one exception is a configured
 * cap SMALLER than the marker itself, which leaves no room for message text at
 * all; the marker alone is returned there, so the bound is
 * `max(maxValueBytes, 15)`. Reporting the truncation is worth those 15 bytes,
 * and the default cap is 32 KiB.
 * @param message - the error message from an inbound (possibly forged) done frame.
 * @param maxValueBytes - the configured completion-value budget, reused here.
 * @returns the message unchanged, or its byte-capped form on overflow.
 */
function capMessage(message: string, maxValueBytes: number): string {
  // Code-unit bounds BEFORE any encode, so a forged done frame carrying a
  // message anywhere below the 256 MiB fd-3 frame ceiling cannot force a
  // full-length UTF-8 copy under a 32 KiB cap. One UTF-16 code unit encodes to
  // at least one UTF-8 byte and at most three: three for a non-ASCII BMP
  // character, two apiece for the pair halves sharing an astral code point's
  // four bytes, and three for a LONE surrogate, which `Buffer.from` renders as
  // U+FFFD. So at most maxValueBytes/3 code units cannot overflow the cap and
  // need no encode at all...
  if (message.length * 3 <= maxValueBytes) return message
  // ...and nothing past the first maxValueBytes code units can fit inside it,
  // so only that prefix is ever encoded — at most 3 * maxValueBytes bytes.
  const keep = Math.min(message.length, maxValueBytes)
  const whole = keep === message.length
  const bytes = Buffer.from(whole ? message : message.slice(0, keep), 'utf8')
  // A message that fits is measured against the WHOLE cap: it gets no marker,
  // so reserving marker bytes here would truncate text that was within budget.
  if (whole && bytes.length <= maxValueBytes) return message
  // Past this point the message IS being truncated, so the marker WILL be
  // appended and its bytes come out of the cap instead of sitting on top of it.
  const budget = Math.max(0, maxValueBytes - TRUNCATION_MARKER_BYTES)
  // Trim back to the last complete UTF-8 sequence: a cut through a multibyte
  // character would decode as U+FFFD — corrupting the diagnostic AND
  // exceeding the byte cap, since the replacement character itself encodes
  // to three bytes. Continuation bytes are 0b10xxxxxx; at most three of them
  // precede a lead byte.
  //
  // This also covers a code-unit prefix ending on a HIGH SURROGATE whose low
  // half sits outside it, which `Buffer.from` encodes as U+FFFD: that orphan
  // occupies the last three bytes of `bytes`, and `bytes` is at least
  // `maxValueBytes + 2` long here (one byte per retained unit, three for the
  // orphan), so it starts past `budget` and is always cut. Reserving the
  // marker is what makes that hold; cutting at `maxValueBytes` itself did not,
  // and needed an explicit surrogate check.
  let end = Math.min(budget, bytes.length)
  while (end > 0 && ((bytes[end] as number) & 0b1100_0000) === 0b1000_0000) end--
  return `${bytes.subarray(0, end).toString('utf8')}${TRUNCATION_MARKER}`
}

/**
 * Copy an fd-3 line residual into a fresh, right-sized Buffer so it no longer
 * shares the joined-frame allocation it was sliced from.
 *
 * After the newline loop over a `Buffer.concat` of the pending chunks, the
 * leftover partial line is a `subarray` VIEW onto that concat's backing store.
 * A view keeps the ENTIRE backing allocation alive for as long as it is
 * retained, so carrying the view forward as the next pending chunk would pin a
 * whole large frame's worth of memory behind a tiny trailing fragment — and the
 * `pendingBytes` counter, set to the fragment's own length, would no longer
 * measure the memory actually held. `Buffer.from` allocates exactly
 * `residual.length` bytes and copies, letting the concat allocation be
 * collected; an empty residual carries nothing forward.
 * @param residual - the leftover slice after the last newline (a view).
 * @returns the pending-chunk list to carry forward: `[copy]`, or `[]` when empty.
 */
export function detachResidual(residual: Buffer): Buffer[] {
  return residual.length > 0 ? [Buffer.from(residual)] : []
}

/** One namespace after seam validation: its callables plus the optional typed-rejection contract. */
interface ValidatedNamespace {
  functions: Record<string, CodeBindingFunction>
  errorClass?: CodeBindingErrorClass
}

/**
 * One in-flight run's host-side state, tracked for disposal so teardown can
 * fail every live run as `abort` and AWAIT each child's exit.
 */
interface LiveRun {
  kill(sig: NodeJS.Signals): void
  settle(failure: CodeRunFailure): void
  finished: Promise<void>
}

/**
 * The shipped {@link CodeRuntime} backend registering as `codeRuntime`. Every
 * cap is validated config; every long-running operation honors the request's
 * `AbortSignal`; every disposer awaits child-process exit.
 */
export class PythonCodeRuntime extends CodeRuntime {
  static Config: z<Config> = z.object({
    cpuSeconds: z.number().default(60),
    maxWallMs: z.number().default(600_000),
    addressSpaceMb: z.number().default(512),
    maxLogBytes: z.number().default(65_536),
    maxValueBytes: z.number().default(32_768),
    graceMs: z.number().default(3_000),
    pythonBin: z.string().default('python3'),
  })

  readonly language = 'python'
  readonly isolation = 'process'

  private readonly config: ResolvedConfig
  private readonly live = new Set<LiveRun>()
  private disposed = false

  /* jscpd:ignore-start -- parallel to code-runtime-worker: sibling backends keep symmetric constructor/teardown/run shapes. */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Reject at load on Windows: the bootstrap imports the POSIX-only `resource`
    // module for RLIMIT_CPU/RLIMIT_AS, spawns with a positional fd 3, and
    // terminates via negative-PID process-group signals — none of which exist
    // on Windows. Registering ctx.codeRuntime there would let assembly succeed
    // and defer the failure to the first run. The asymmetry with the worker
    // backend is intentional: that backend is cross-platform; this one is not.
    if (process.platform === 'win32') {
      throw new Error('dsh-code-runtime-python: this backend requires a Unix platform (POSIX rlimits, fd-3 stdio, process-group signals); it cannot run on Windows')
    }
    this.config = config as ResolvedConfig
    for (const [key, value] of Object.entries(this.config)) {
      if (typeof value === 'number' && !(Number.isFinite(value) && value > 0)) {
        throw new Error(`dsh-code-runtime-python: config.${key} must be a positive number, got ${String(value)}`)
      }
    }
    // cpuSeconds crosses to the child's setrlimit(RLIMIT_CPU) raw; a float
    // raises TypeError inside every child (a late per-run failure). Reject it
    // at load. Other numeric caps are consumed as numbers host-side or
    // int()-truncated in the bootstrap, so they need no integer gate.
    if (!Number.isInteger(this.config.cpuSeconds)) {
      throw new Error(`dsh-code-runtime-python: config.cpuSeconds must be a positive integer, got ${String(this.config.cpuSeconds)}`)
    }
    // Finite is not the same as representable as an rlimit. `cpuSeconds` and its
    // `+ 1` hard limit both cross to `setrlimit` as integers, and `1e100` clears
    // `Number.isInteger` while being far past the safe range, so it cannot round
    // -trip: the child sees a different number than was configured. The `+ 1` is
    // what gets checked because that is the larger of the two values sent.
    if (!Number.isSafeInteger(this.config.cpuSeconds + 1)) {
      throw new Error(`dsh-code-runtime-python: config.cpuSeconds must be at most ${Number.MAX_SAFE_INTEGER - 1} (it and its +1 hard limit cross to setrlimit as exact integers), got ${String(this.config.cpuSeconds)}`)
    }
    // `addressSpaceMb` is multiplied by 1 MiB before it is framed, and a large
    // finite value overflows to `Infinity` there — which `encodeJsonPlain`
    // renders as `null`, so the child receives no limit at all and every run
    // ends in a bootstrap exception rather than a load-time configuration error.
    // Checking the DERIVED byte count is what catches it; the input itself looks
    // ordinary. Safe-integer, not merely finite, since the value must survive
    // the JSON round trip exactly.
    if (!Number.isSafeInteger(this.config.addressSpaceMb * 1024 * 1024)) {
      throw new Error(`dsh-code-runtime-python: config.addressSpaceMb must be at most ${Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024))} (its byte count crosses the wire as an exact integer), got ${String(this.config.addressSpaceMb)}`)
    }
    // `pythonBin` reaches `spawn` as the executable path, where two values the
    // string schema admits fail late and unhelpfully. An empty string makes
    // `spawn` throw `ERR_INVALID_ARG_VALUE` synchronously, and an embedded NUL
    // throws `ERR_INVALID_ARG_TYPE` — both from inside `run()`, so the method
    // REJECTS instead of resolving the `worker-exit` the seam promises for a
    // child that cannot start. An empty basename also makes `resolvePythonBin`
    // probe every PATH directory itself for the X_OK bit. Both are
    // self-contained configuration errors, so they fail at load.
    if (this.config.pythonBin === '' || this.config.pythonBin.includes('\0')) {
      throw new Error(`dsh-code-runtime-python: config.pythonBin must be a non-empty path without NUL bytes, got ${JSON.stringify(this.config.pythonBin)}`)
    }
    // `maxWallMs` and `graceMs` are armed with setTimeout, which clamps any
    // delay past MAX_TIMER_DELAY_MS to 1 ms without a word — turning a
    // generous ceiling into an instant timeout and a generous grace period into
    // an instant SIGKILL. `graceMs` is checked against the margin the
    // close-deadline adds on top, since that sum is what gets armed.
    if (this.config.maxWallMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-code-runtime-python: config.maxWallMs must not exceed ${MAX_TIMER_DELAY_MS} (setTimeout clamps a larger delay to 1ms), got ${String(this.config.maxWallMs)}`)
    }
    if (this.config.graceMs + CLOSE_REAP_MARGIN_MS > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-code-runtime-python: config.graceMs must not exceed ${MAX_TIMER_DELAY_MS - CLOSE_REAP_MARGIN_MS} (its close deadline adds ${CLOSE_REAP_MARGIN_MS}ms, and setTimeout clamps a larger delay to 1ms), got ${String(this.config.graceMs)}`)
    }
    // The output caps are budgets for a payload that has to cross fd 3 inside
    // one frame, and the framing ceiling is fixed. A cap above what a frame can
    // carry is unsatisfiable: a completion or log entry that the cap admits
    // arrives as an over-ceiling frame and fails the run as `worker-exit`
    // instead of the `output-limit` the cap describes — a silent inversion, so
    // it fails at load. Both budgets are metered in SERIALIZED (JSON-escaped)
    // bytes — the host log ledger charges `Buffer.byteLength(JSON.stringify(text))`
    // and `checkDoneValue` measures the escaped form — so a payload admitted
    // under the cap occupies at most `cap + envelope` bytes on the wire; escaping
    // is already inside the charge and must not be multiplied in again. The
    // admissible cap is therefore `ceiling - envelope`.
    for (const key of ['maxLogBytes', 'maxValueBytes'] as const) {
      const limit = FRAME_CEILING_BYTES - FRAME_ENVELOPE_BYTES
      if (this.config[key] > limit) {
        throw new Error(`dsh-code-runtime-python: config.${key} must not exceed ${limit} (a payload that large cannot cross the ${FRAME_CEILING_BYTES}-byte fd-3 frame ceiling, so the run would fail as worker-exit rather than output-limit), got ${String(this.config[key])}`)
      }
    }
    ctx.effect(() => () => this.teardown(), 'python code-runtime teardown')
  }

  /**
   * Dispose to quiescence: fail every in-flight run as aborted and AWAIT each
   * child's exit so no subprocess outlives the fiber.
   */
  private async teardown(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const run of runs) run.settle({ kind: 'abort', message: 'runtime disposed' })
    // Awaiting `finished` is also what clears staging: that promise resolves
    // inside the run's own `settle`, which removes its directory first. So there
    // is deliberately no sweep here — a second pass could only ever find an
    // empty set, and an unreachable cleanup path is worse than none, since it
    // reads as the real guarantee while never running.
    await Promise.all(runs.map(run => run.finished))
  }

  /**
   * Execute one program in a fresh Python subprocess. Program outcomes resolve
   * with `result.error`; the method rejects only for seam misuse.
   */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-code-runtime-python: run() after disposal')
    const bindings = this.validateBindings(request)
    if (request.signal?.aborted) {
      return { logs: [], error: { kind: 'abort', message: messageOf(request.signal.reason) } }
    }
    let bootstrapPath: string
    try {
      // The interpreter is an external process, so the entry script has to sit
      // on the real filesystem; see materializePyScripts. One copy PER RUN,
      // synchronously, so no async boundary opens before `execute` registers the
      // run and installs the abort listener.
      bootstrapPath = materializePyScripts()
    } catch (error: unknown) {
      // A full or read-only temp filesystem, or a packaged asset the deployment
      // failed to ship, is a SUBSTRATE failure — the same class as a child that
      // cannot start. The seam permits rejection only for misuse, so this
      // resolves as `worker-exit` rather than throwing out of `run()`.
      return { logs: [], error: { kind: 'worker-exit', message: `failed to stage the python bootstrap: ${messageOf(error)}` } }
    }
    return await this.execute(request, bindings, bootstrapPath)
  }
  /* jscpd:ignore-end */

  /**
   * Reject (seam misuse) malformed binding namespaces: non-identifier or
   * reserved globals/error classes, duplicates, and colliding or
   * runtime-owned injected globals.
   */
  private validateBindings(request: CodeRunRequest): Map<string, ValidatedNamespace> {
    const bindings = new Map<string, ValidatedNamespace>()
    // Every name the bootstrap injects into the program's one global namespace:
    // namespace globals plus error-class names. They must be a collision-free
    // set that avoids the runtime's own slots, or a later injection silently
    // overwrites an earlier one (or the completion/builtins slot) and the run
    // fails obscurely at execution time.
    const injectedGlobals = new Set<string>()
    const claimGlobal = (name: string, role: string): void => {
      if (RUNTIME_OWNED_GLOBALS.has(name)) {
        throw new Error(`dsh-code-runtime-python: ${role} ${JSON.stringify(name)} collides with a runtime-owned global`)
      }
      if (injectedGlobals.has(name)) {
        throw new Error(`dsh-code-runtime-python: ${role} ${JSON.stringify(name)} collides with another injected global`)
      }
      injectedGlobals.add(name)
    }
    for (const namespace of request.bindings) {
      if (!IDENTIFIER.test(namespace.global) || RESERVED_NAMES.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-python: binding global ${JSON.stringify(namespace.global)} is not a usable Python identifier`)
      }
      if (bindings.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-python: duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      claimGlobal(namespace.global, 'binding global')
      // The error class becomes a program global and its member property an
      // attribute name, so both face the Python identifier rules; the member
      // additionally must be assignable on a BaseException instance.
      const errorClass = namespace.errorClass
      if (errorClass) {
        if (!IDENTIFIER.test(errorClass.name) || RESERVED_NAMES.has(errorClass.name)) {
          throw new Error(`dsh-code-runtime-python: errorClass.name ${JSON.stringify(errorClass.name)} is not a usable Python identifier`)
        }
        // Any non-empty own attribute name is settable via setattr (the
        // program reads exotic names like `tool-name` with getattr), matching
        // the seam contract and the worker backend — only the seam-excluded
        // and protocol-reserved members below are refused.
        if (errorClass.memberNameProperty.length === 0) {
          throw new Error('dsh-code-runtime-python: errorClass.memberNameProperty must be a non-empty attribute name')
        }
        if (EXCEPTION_RESERVED_MEMBERS.has(errorClass.memberNameProperty) || DUNDER.test(errorClass.memberNameProperty)) {
          throw new Error(`dsh-code-runtime-python: errorClass.memberNameProperty ${JSON.stringify(errorClass.memberNameProperty)} is a reserved error member and cannot be assigned`)
        }
        claimGlobal(errorClass.name, 'errorClass.name')
      }
      bindings.set(namespace.global, { functions: namespace.functions, ...errorClass ? { errorClass } : {} })
    }
    return bindings
  }

  /** Spawn the child for one validated run and drive it to settlement. */
  private execute(
    request: CodeRunRequest,
    bindings: Map<string, ValidatedNamespace>,
    bootstrapPath: string,
  ): Promise<CodeRunResult> {
    // This run's own staging directory, removed at settlement.
    const bootstrapDir = dirname(bootstrapPath)
    // Explicit pipe count of 4 puts the framed-JSON channel at fd 3 in the child.
    // Resolve the interpreter against the current PATH first: the child's empty
    // env would otherwise strip PATH and miss a basename python3 (see resolvePythonBin).
    const child = spawn(resolvePythonBin(this.config.pythonBin), ['-I', bootstrapPath], {
      env: {},
      detached: true, // Own process group — kill(-pid, sig) reaches subprocesses the model program spawns.
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })

    // Fd 3 is a duplex pipe carrying protocol frames. Node types extra stdio
    // entries as `Stream | null`; the runtime shape with `'pipe'` is a duplex,
    // so we narrow at the boundary rather than smearing casts below. Stdout
    // and stderr are guaranteed non-null under `'pipe'` and typed as such.
    const proto = child.stdio[3] as Duplex | null
    /* v8 ignore next 3 -- `'pipe'` stdio always populates fd 3; guarding Node's `Stream | null` typing widening. */
    if (proto === null) {
      throw new Error('dsh-code-runtime-python: python subprocess spawned without a fd-3 pipe')
    }

    return new Promise<CodeRunResult>((resolve) => {
      let settled = false
      const logs: string[] = []

      // One host-side ledger covers normal frames, forged frames, and stray stdout bytes.
      let logBudget = this.config.maxLogBytes
      let logsTruncated = false
      const admit = (text: string): void => {
        /* v8 ignore next -- post-truncation admits no-op; needs child to keep streaming after ledger drops. */
        if (logsTruncated) return
        // Each entry is charged its SERIALIZED cost — JSON.stringify's quotes
        // and escapes plus one separator byte — because the seam bounds the
        // serialized outer logs payload, and control characters expand
        // several-fold under JSON escaping (a "\x00" flood would otherwise
        // admit 6x its charge). The charge also puts a floor under an empty
        // entry (its two quotes plus separator), so a `while True: print()`
        // flood of zero-byte lines exhausts the ledger instead of growing the
        // retained array without ever touching the budget. The one fixed
        // truncation-marker entry is envelope, not payload, and rides
        // uncharged.
        //
        // Cheap lower bound FIRST, before the escaped copy exists: every
        // UTF-16 code unit costs at least one serialized byte (an ASCII
        // character is one byte; a control character is six as `\uXXXX`; a
        // non-ASCII BMP character is two or three; each half of a surrogate
        // pair contributes two of the four bytes its code point encodes to),
        // and the JSON form adds two quotes on top of the separator byte. So
        // `text.length + 3` never exceeds the true cost, and a forged `log`
        // frame carrying a control-heavy string anywhere below the 256 MiB
        // frame ceiling truncates here instead of allocating a
        // hundreds-of-megabytes escaped copy under a small maxLogBytes.
        if (text.length + 3 > logBudget) {
          logsTruncated = true
          logs.push(logTruncationMarker(this.config.maxLogBytes))
          return
        }
        // Past the lower bound the escape expands the string at most sixfold,
        // so this copy is bounded by ~6x the remaining budget.
        const cost = Buffer.byteLength(JSON.stringify(text), 'utf8') + 1
        if (cost > logBudget) {
          logsTruncated = true
          logs.push(logTruncationMarker(this.config.maxLogBytes))
          return
        }
        logBudget -= cost
        logs.push(text)
      }

      // Stray-byte capture: anything the child writes to its stdout/stderr
      // (native prints, C-extension writes) still counts against the ledger.
      // One STREAMING decoder per pipe: a multibyte UTF-8 sequence can span
      // two chunks (native writes, os.write past the pipe buffer), and
      // decoding each chunk independently would corrupt both halves into
      // replacement characters. StringDecoder holds the partial sequence
      // until its continuation bytes arrive; the pipes are separate byte
      // streams, so they cannot share one decoder.
      const strayOut = new StringDecoder('utf8')
      const strayErr = new StringDecoder('utf8')
      const captureStray = (decoder: StringDecoder, chunk: Buffer): void => {
        const text = decoder.write(chunk)
        // Empty only when the chunk is nothing but a partial multibyte
        // sequence — needs a pipe boundary INSIDE one character, which cannot
        // be forced deterministically from the child side.
        /* v8 ignore next */
        if (text.length > 0) admit(text)
      }
      child.stdout.on('data', (chunk: Buffer) => { captureStray(strayOut, chunk) })
      child.stderr.on('data', (chunk: Buffer) => { captureStray(strayErr, chunk) })
      // Flush each decoder when its pipe ends: output that STOPS mid-sequence
      // (native code killed between bytes) leaves the partial character in
      // the decoder, and end() renders it as U+FFFD rather than dropping the
      // evidence. `end` fires before `close` settles the run, so the flush is
      // admitted into `logs`.
      const flushStray = (decoder: StringDecoder): void => {
        const tail = decoder.end()
        if (tail.length > 0) admit(tail)
      }
      child.stdout.on('end', () => { flushStray(strayOut) })
      child.stderr.on('end', () => { flushStray(strayErr) })

      // Line-framed JSON reader over fd 3. The unframed buffer is bounded: a
      // hostile program can loop `os.write(3, b"A"*4096)` with no newline to
      // exhaust HOST memory, which the child's RLIMIT_AS does not cover. It is
      // a memory-safety bound only: legitimate `call` frames may be large
      // (binding traffic has no seam byte cap), so it never keys off
      // maxValueBytes.
      // Buffered as raw chunks with a running byte counter: appending is O(1)
      // per chunk (a string `+=` accumulator would re-copy the whole prefix on
      // every pipe chunk — quadratic on a large frame), joins happen only when
      // a newline actually arrived, and the ceiling check reads the counter.
      let pendingChunks: Buffer[] = []
      // Fragments already merged into finished blocks. Kept separate from
      // `pendingChunks` so sealing never re-copies what earlier seals produced;
      // the two together are the unframed buffer, and `pendingBytes` counts both.
      let sealedBlocks: Buffer[] = []
      let pendingBytes = 0
      proto.on('data', (chunk: Buffer) => {
        // Once settled, stop accumulating: a hostile child that keeps flooding
        // fd 3 between finish() and close must not regrow the host buffer.
        /* v8 ignore next -- post-settlement data needs the child to outrace close after we decided. */
        if (settled) return
        pendingChunks.push(chunk)
        pendingBytes += chunk.length
        // Check the counter BEFORE the join, not the joined line afterwards:
        // Buffer.concat allocates a second copy of everything held, so a line
        // measured after the concat had already cost twice the ceiling — the
        // ceiling this check exists to enforce. The counter is exact and free,
        // and the retained chunks are released here so the rejected payload is
        // not still held while the run settles.
        // Reading the counter rather than the line length also charges the
        // whole unframed buffer, which over-counts by at most the newline-
        // bearing chunk's own length (one pipe read): the residual carried in
        // is always a partial line, so nothing but the current line can be
        // larger than that.
        if (pendingBytes > FRAME_CEILING_BYTES) {
          pendingChunks = []
          sealedBlocks = []
          pendingBytes = 0
          finish({ error: { kind: 'worker-exit', message: `protocol frame exceeded ${FRAME_CEILING_BYTES} bytes on fd 3` } })
          return
        }
        // Bound the FRAGMENT COUNT as well as the byte total, but only AFTER the
        // ceiling check above: sealing first would `Buffer.concat` an already
        // over-ceiling payload and allocate a second copy of it before the
        // rejection ran, which is the peak-memory doubling that check exists to
        // prevent.
        //
        // Fragment count needs its own bound because the ceiling meters payload
        // bytes only, while each retained chunk is a separate Buffer with object
        // and backing-store overhead no byte count sees: 5000 single-byte
        // newline-free writes produced 5000 chunks holding 5031 bytes, so a
        // program pacing such writes could accumulate millions of objects inside
        // the wall budget and exhaust the host heap far below the ceiling.
        //
        // Sealing appends to a list of finished blocks instead of re-merging
        // everything held. Concatenating the whole buffer at each threshold
        // re-copied the entire accumulated prefix every time, so the cumulative
        // copy volume was quadratic, not the amortized O(1) an earlier revision
        // of this comment claimed: 10 MiB trickled a byte at a time copies
        // 53.7 GB that way, and 64 MiB copies 2.2 TB. Here each byte is copied
        // once into its block and never again, so the total stays linear, and the
        // block list is itself bounded — every block holds at least
        // `MAX_PENDING_CHUNKS - 1` bytes, so reaching the 256 MiB ceiling admits
        // at most a few hundred thousand of them.
        if (pendingChunks.length >= MAX_PENDING_CHUNKS) {
          sealedBlocks.push(Buffer.concat(pendingChunks))
          pendingChunks = []
        }
        if (chunk.includes(0x0a)) {
          let buffered = Buffer.concat(sealedBlocks.length > 0 ? [...sealedBlocks, ...pendingChunks] : pendingChunks)
          sealedBlocks = []
          let newline: number
          while ((newline = buffered.indexOf(0x0a)) >= 0) {
            const line = buffered.subarray(0, newline)
            buffered = buffered.subarray(newline + 1)
            /* v8 ignore next -- an empty line comes only from a forged `\n\n` write. */
            if (line.length === 0) continue
            const text = line.toString('utf8')
            // JSON.parse would silently ROUND an integer token outside the
            // safe range before validation could see it, so a forged frame
            // could smuggle a corrupted value into a dispatch or completion.
            // An honest child never emits one (its validator rejects unsafe
            // ints), so such a frame is hostile traffic: drop it like any
            // other junk frame.
            if (hasUnsafeIntegerToken(text)) continue
            let parsed: unknown
            try {
              parsed = JSON.parse(text) as unknown
            } catch {
              continue // Junk frames drop silently (hostile-peer stance).
            }
            const message = validateChildFrame(parsed)
            if (message) handleFrame(message)
          }
          // Carry the residual forward as a fresh, right-sized copy, NOT the
          // `subarray` view: a view keeps the whole joined-frame allocation from
          // the `Buffer.concat` above alive, so a large frame followed by a tiny
          // trailing fragment would pin megabytes while `pendingBytes` reported
          // only the fragment's length. See {@link detachResidual}.
          pendingChunks = detachResidual(buffered)
          pendingBytes = buffered.length
        }
      })

      // Duplicate-call suppression against the honest child's id SEQUENCE, not
      // a set of every id seen. `dispatch` sends consecutive ids from 0 with no
      // gaps — it advances its counter only after the write succeeds, so a call
      // rejected before reaching the wire consumes nothing — which makes the
      // next legitimate id exactly `nextCallId`.
      //
      // Retaining a set instead let a program write an unbounded run of unique
      // forged ids, each below the 256 MiB per-frame ceiling so nothing
      // rejected them, and grow host memory for the whole run. Accepting any
      // id above a high-water mark would have been just as wrong in the other
      // direction: one forged `{"id": 9999}` would starve every honest call
      // after it. The exact successor is the only test that both bounds the
      // retained state to one number and cannot be poisoned by a forgery.
      let nextCallId = 0

      const handleFrame = (message: ChildToHost): void => {
        /* v8 ignore next -- late frame after settlement; defensive against forged post-settlement traffic. */
        if (settled) return
        switch (message.type) {
          case 'boot-ack':
            return // Presently informational.
          case 'log':
            if (message.truncated === true) {
              // The CHILD ledger hit its cap. Its marker is the last log text
              // there will be, so record it and stop host capture at the same
              // point: admitting it as ordinary text left the host budget open,
              // so later direct `os.write(1, ...)` bytes were retained AFTER the
              // marker and a host-side exhaustion could append a second one.
              // Both ledgers are keyed to the same `maxLogBytes`, so one marker
              // describes the run.
              if (!logsTruncated) {
                logsTruncated = true
                // The host's OWN marker, never the frame's text. `truncated` is
                // attacker-reachable, so trusting the text let a program write
                // `{"type":"log","truncated":true,"text":<1 MiB>}` and land all
                // of it in `logs` under a 64-byte `maxLogBytes` — measured, the
                // whole megabyte was retained, bypassing `admit` and its
                // ceiling. Both ledgers key off the same `maxLogBytes`, so the
                // marker the host generates says the same thing the child's
                // would have.
                logs.push(logTruncationMarker(this.config.maxLogBytes))
              }
              return
            }
            admit(message.text)
            return
          case 'done': {
            if (message.error) {
              finish({ error: { kind: message.error.kind, message: capMessage(message.error.message, this.config.maxValueBytes) } })
              return
            }
            if (message.value === undefined) {
              finish({})
              return
            }
            // Re-enforce the completion budget and number losslessness
            // host-side: a forged done frame bypasses the Python-side
            // _done_with_value check, and validateChildFrame no longer scans
            // the value (an unbounded scan would push every member of a wide
            // forgery before any cap ran). checkDoneValue folds both jobs into
            // one bounded, iterative traversal — iterative because the seam's
            // CodeJsonValue has no depth limit and an honest deep-but-small
            // completion must cross intact rather than dying on stringify
            // recursion; bounded because it stops at the cap without
            // materializing the encoding, rejecting a forged value anywhere
            // below the 256 MiB frame ceiling before it forces host-side copies.
            // The seam forbids substituting a rendered/truncated value, so an
            // oversized value fails the run as output-limit and a non-lossless
            // number as invalid-output. The value is JSON-plain by construction
            // (it came from JSON.parse of the frame), the traversal's precondition.
            const check = checkDoneValue(message.value, this.config.maxValueBytes)
            if (!check.ok) {
              finish(check.reason === 'over-budget'
                ? { error: { kind: 'output-limit', message: `completion value exceeded ${this.config.maxValueBytes} bytes` } }
                : { error: { kind: 'invalid-output', message: 'completion value contained a non-lossless number' } })
              return
            }
            finish({ value: message.value as CodeJsonValue })
            return
          }
          case 'call': {
            if (message.id !== nextCallId) return
            nextCallId += 1
            const record = bindings.get(message.global)?.functions
            const fn = record && Object.hasOwn(record, message.name) ? record[message.name] : undefined
            if (typeof fn !== 'function') {
              // `call.global` and `call.name` are attacker-controlled strings
              // with no byte cap of their own — only the 256 MiB fd-3 frame
              // ceiling — so each is sliced to `maxValueBytes` CODE UNITS
              // BEFORE it reaches the template. Interpolating them whole would
              // copy them into the message, `JSON.stringify` would copy the
              // escaped form, `encodeJsonPlain` the frame, and the pipe write
              // again: four full-size host allocations off one below-ceiling
              // forgery, past every hostile-peer bound the log and done-error
              // paths apply. Nothing past the first `maxValueBytes` code units
              // of either field can survive the byte cap anyway, so the slices
              // lose only text `capMessage` would drop, and that final cap
              // gives this reply the same budget and marker as a forged done
              // error.
              const cap = this.config.maxValueBytes
              const target = `${message.global.slice(0, cap)}.${message.name.slice(0, cap)}`
              sendReply({ type: 'reply', id: message.id, ok: false, message: capMessage(`unknown binding ${JSON.stringify(target)}`, cap) })
              return
            }
            void (async () => {
              try {
                const resolved = await fn(message.args)
                // The seam requires a lossy resolution to REJECT descriptively,
                // not silently coerce: a raw JSON.stringify would turn NaN/
                // Infinity into null and drop undefined fields. Snapshot through
                // the same lossless-JSON boundary the worker backend uses (also
                // iterative, so a deeply nested value cannot overflow the stack).
                const value = snapshotJsonValue(resolved)
                if (value === undefined) {
                  sendReply({ type: 'reply', id: message.id, ok: false, message: 'binding resolution must be lossless JSON' })
                  return
                }
                sendReply({ type: 'reply', id: message.id, ok: true, value })
              } catch (error: unknown) {
                sendReply({ type: 'reply', id: message.id, ok: false, message: messageOf(error) })
              }
            })()
            return
          }
        }
      }

      // Write one reply frame with the iterative encoder: a binding
      // resolution has no seam-level depth or byte cap, so a deeply nested
      // value must not die on JSON.stringify's recursion. The payload is
      // JSON-plain by construction (snapshotJsonValue output, or literal
      // strings/numbers), which is encodeJsonPlain's precondition. A closed
      // pipe (child already gone) is swallowed since the close path settles
      // the run.
      const sendReply = (payload: ReplyMessage): void => {
        /* v8 ignore next -- `settled` covers a race where the child exits between decision and write. */
        if (settled) return
        try {
          proto.write(`${encodeJsonPlain(payload)}\n`)
        } catch {
          // Pipe closed under us (child exited). The close path finishes the run.
        }
      }

      // Escalate SIGTERM → grace → SIGKILL on the entire process group. Idempotent
      // via `killing`.
      let killing = false
      let graceTimer: NodeJS.Timeout | undefined
      // A backstop for the one case `close` cannot cover: model code that starts
      // a descendant with `os.setsid()`/`start_new_session=True` moves it into a
      // fresh process group, so the SIGTERM/SIGKILL aimed at the child's group
      // (`kill(-pid)`) never reaches it. If that orphan inherited stdout/stderr/
      // fd 3 and outlives the run, those pipes stay open and `close` never fires
      // — leaving run() (and a teardown awaiting `finished`) hung indefinitely.
      // finish() arms this deadline; when it fires we detach our stream handles
      // and settle on the already-decided result regardless of the orphan.
      let closeDeadline: NodeJS.Timeout | undefined
      const killGroup = (sig: NodeJS.Signals): void => {
        try {
          /* v8 ignore next -- undefined pid means spawn never produced a process; finish() short-circuits before reaching kill(). */
          if (child.pid !== undefined) process.kill(-child.pid, sig)
        } catch {
          // ESRCH — the process already died. Nothing to do.
        }
      }
      const kill = (): void => {
        /* v8 ignore next -- kill() is idempotent; tests do not double-invoke it. */
        if (killing) return
        killing = true
        killGroup('SIGTERM')
        // Escalate to SIGKILL after the grace window. The timer is `unref`'d so a
        // pending SIGKILL never keeps the host process alive on its own; the
        // guarantee that a same-group survivor is actually reaped before the fiber
        // goes quiescent is enforced by settle() awaiting the group's death (see
        // there), NOT by this timer firing during host lifetime. A setsid-escaped
        // orphan in a FRESH group is the different case `closeDeadline` in finish()
        // covers, since `close` never fires there.
        graceTimer = setTimeout(() => { killGroup('SIGKILL') }, this.config.graceMs)
        graceTimer.unref()
      }
      // True once the group has no members left: a signal-0 probe to the whole
      // group (`kill(-pid, 0)`) throws ESRCH when empty (EPERM would still mean a
      // member exists). Only meaningful once a spawn produced a pid.
      const groupEmpty = (): boolean => {
        /* v8 ignore next -- pid is always defined once escalation runs; the guard narrows the type. */
        if (child.pid === undefined) return true
        try {
          process.kill(-child.pid, 0)
          return false
        } catch (error: unknown) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH'
        }
      }

      let finishResolve!: () => void
      const finished = new Promise<void>((done) => { finishResolve = done })
      let resolved = false
      // The decided terminal result for a live child, recorded by finish() and
      // read by the `close` handler that settles it once the pipes have drained.
      let decided: Omit<CodeRunResult, 'logs'>

      // The single settlement point: resolve run() with the decided result and
      // mark the fiber quiescent. Idempotent — the first call wins, so a later
      // `close` after done/timeout/abort is absorbed as a no-op.
      const settle = (result: Omit<CodeRunResult, 'logs'>): void => {
        if (resolved) return
        resolved = true
        if (closeDeadline !== undefined) clearTimeout(closeDeadline)
        // The child has exited by now (settle runs on `close`, or on a spawn
        // that produced no pid), so its staging directory is no longer read and
        // this run's copy goes away with it. Removed SYNCHRONOUSLY, before
        // `resolve` below: a fire-and-forget removal left the directory on disk
        // when `run()` resolved, so a caller could not observe the "gone by
        // settlement" contract at all. Two files cost nothing to unlink here.
        try {
          rmSync(bootstrapDir, { recursive: true, force: true })
        } catch {
          // Swallows only a failure to remove this run's staging directory —
          // `force` already absorbs a missing one, so what remains is a
          // filesystem-level refusal. The run's own outcome is already decided
          // and must still be delivered, and teardown retries what stays
          // tracked; the directory holds no secret, only a copy of two
          // checked-in scripts.
        }
        resolve({ ...result, logs })
        // Mark the fiber quiescent for THIS run: drop it from `live` and resolve
        // `finished` (what teardown awaits). Deferred until the process group is
        // actually empty — dropping from `live` before then would let a
        // `dispose()` that races a just-resolved run() snapshot an empty `live`
        // and return while a same-group survivor is still alive, making teardown's
        // "no subprocess outlives the fiber" false for that window. Keeping the
        // run in `live` until the group is reaped is exactly what makes a
        // concurrent teardown await it.
        const finalize = (): void => {
          this.live.delete(live)
          finishResolve()
        }
        // `finished` is what teardown awaits to honor "no subprocess outlives the
        // fiber". When no escalation ran (normal completion, no kill) or the
        // group is already empty, cancel the pending SIGKILL and finalize now.
        // Clearing it is what bounds the PID-reuse hazard: an armed `kill(-pid)`
        // left to fire up to graceMs later could hit a RECYCLED pgid once the
        // kernel reused the leader's pid, SIGKILLing an unrelated group. So the
        // timer stays armed only while a real survivor exists — a same-group
        // descendant that ignored SIGTERM but released the pipes, still alive
        // here because its `close` is what got us to settle. In that case
        // withhold finalize and poll the group on REF'd timers (a short-lived
        // host would otherwise exit before the unref'd SIGKILL fired, reparenting
        // the survivor to init), clearing the timer the moment the group empties;
        // the wait is bounded by the same graceMs + margin the escalation uses.
        if (!killing || groupEmpty()) {
          if (graceTimer !== undefined) clearTimeout(graceTimer)
          finalize()
          return
        }
        const deadline = Date.now() + this.config.graceMs + CLOSE_REAP_MARGIN_MS
        const pollGroup = (): void => {
          if (groupEmpty() || Date.now() >= deadline) {
            if (graceTimer !== undefined) clearTimeout(graceTimer)
            finalize()
            return
          }
          setTimeout(pollGroup, GROUP_REAP_POLL_MS)
        }
        pollGroup()
      }

      const finish = (result: Omit<CodeRunResult, 'logs'>): void => {
        if (settled) return
        settled = true
        decided = result
        clearTimeout(wallTimer)
        request.signal?.removeEventListener('abort', onAbort)
        // A spawn failure (ENOENT, EACCES) never produced a pid, so there is no
        // process to kill: settle now. Its `close` still fires later and reaches
        // the idempotent settle() again as a no-op.
        if (child.pid === undefined) {
          settle(result)
          return
        }
        // Live child: SIGTERM→grace→SIGKILL, then let `close` (below) settle the
        // run so any `done` frame buffered on fd 3 is handled first and the
        // process is fully reaped before the fiber goes quiescent.
        kill()
        // `close` awaits every stdio stream draining, which a setsid-escaped
        // orphan holding our inherited pipes can prevent forever. Bound that
        // wait: after SIGKILL has had the grace window plus a margin to reap the
        // child itself, force settlement on the decided result. Detaching the
        // stream handles lets `close` land as a no-op if it ever arrives, and
        // stops the orphan's stray output from being accounted against a run
        // that already finished. `unref` so the deadline never keeps the host
        // process alive on its own.
        closeDeadline = setTimeout(() => {
          proto.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          settle(result)
        }, this.config.graceMs + CLOSE_REAP_MARGIN_MS)
        closeDeadline.unref()
      }

      child.on('error', (error: Error) => {
        finish({ error: { kind: 'worker-exit', message: `python spawn error: ${error.message}` } })
      })
      // `close` (not `exit`) is the settlement trigger: it fires only after the
      // process exits AND every stdio stream — including the fd-3 protocol pipe —
      // has drained, so a `done` frame the child wrote just before exiting is
      // always handled before we settle. macOS can deliver `exit` before that
      // final fd-3 data; keying off `close` makes the ordering irrelevant.
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        // If done/timeout/abort already decided the result, finish() is a no-op
        // and `decided` holds it — a SIGXCPU that arrives after a decision does
        // not override it. Otherwise the child closed before completing: a
        // SIGXCPU close is the kernel's own CPU meter firing — the RLIMIT_CPU
        // soft limit, or the bootstrap's post-settlement getrusage check
        // re-delivering SIGXCPU when a program trapped the soft limit and
        // returned inside the soft-to-hard gap. That kernel-authoritative
        // signal is the ONLY basis for the timeout classification: wall time
        // is not evidence of CPU burn (a sleeping child SIGKILLed by a cgroup
        // OOM killer, an operator, or itself consumed none), so every other
        // signal or code — including an unsolicited SIGKILL, even the
        // hard-limit one — reports as an opaque worker exit.
        finish(signal === 'SIGXCPU'
          ? { error: { kind: 'timeout', message: `CPU budget (${this.config.cpuSeconds}s) exhausted` } }
          : { error: { kind: 'worker-exit', message: `python exited (code=${String(code)}, signal=${String(signal)}) before completing` } })
        settle(decided)
      })

      // Fd-3 and the stdout/stderr pipes emit `error` on early child death
      // (ECONNRESET/EPIPE); swallow them so they do not become uncaught. The
      // authoritative failure signal is `child.on('close')` above.
      const silenceStreamError = (): void => {}
      proto.on('error', silenceStreamError)
      child.stdout.on('error', silenceStreamError)
      child.stderr.on('error', silenceStreamError)

      /* jscpd:ignore-start -- wall-timer/abort/live-run wiring deliberately parallels code-runtime-worker; see the constructor note. */
      const wallTimer = setTimeout(() => {
        finish({ error: { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` } })
      }, this.config.maxWallMs)

      const onAbort = (): void => {
        finish({ error: { kind: 'abort', message: messageOf(request.signal?.reason) } })
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const live: LiveRun = {
        kill,
        finished,
        settle: (failure: CodeRunFailure) => { finish({ error: failure }) },
      }
      this.live.add(live)
      /* jscpd:ignore-end */

      // Send the boot frame once fd 3 is writable. This runs LAST in run()'s
      // synchronous setup: its failure path calls finish(), which reads
      // wallTimer/onAbort and (through settle) live, so those bindings must
      // already be initialized — issuing the write earlier hit their
      // temporal dead zone and threw a ReferenceError that rejected run()
      // instead of resolving the worker-exit it constructs here.
      const boot: BootMessage = {
        type: 'boot',
        cpuSeconds: this.config.cpuSeconds,
        addressSpaceBytes: this.config.addressSpaceMb * 1024 * 1024,
        maxLogBytes: this.config.maxLogBytes,
        maxValueBytes: this.config.maxValueBytes,
        namespaces: [...bindings].map(([global, namespace]) => ({
          global,
          names: Object.keys(namespace.functions),
          ...namespace.errorClass ? { errorClass: namespace.errorClass } : {},
        })),
      }
      try {
        proto.write(`${JSON.stringify(boot)}\n`)
        proto.write(`${JSON.stringify({ type: 'run', program: request.program })}\n`)
      } catch (error: unknown) {
        finish({ error: { kind: 'worker-exit', message: `failed to boot python subprocess: ${messageOf(error)}` } })
        return
      }
    })
  }
}

export default PythonCodeRuntime
