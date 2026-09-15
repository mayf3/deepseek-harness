/**
 * The plugin manager's state: the Host's package views
 * the action in flight, the install run, and the
 * confirmation a destructive action waits on. Every fact comes from the Host — the store
 * re-reads after each action and after every `plugins/changed` event, so a
 * change made on another surface shows here without a manual refresh.
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  PluginDependents,
  PluginEnableResult,
  PluginInspectProblem,
  PluginInstallFailureKind,
  PluginInstallLogChunk,
  PluginInstallProgress,
  PluginInstallRejection,
  PluginInstallRequestId,
  PluginInstallResult,
  PluginPackageView,
  PluginSpecInspection,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** What the last action left to say, shown as a toast; `seq` tells one showing from the next. */
export type ManagerNotice =
  | { readonly kind: 'restart'; readonly packageName: string; readonly seq: number }
  | { readonly kind: 'cancelled'; readonly seq: number }
  | {
    readonly kind: 'failed'
    /** The Host's failure code, which selects the copy. */
    readonly code: string
    /** The Host's reason, shown verbatim. */
    readonly reason: string
    readonly packageName?: string
    readonly rowId?: string
    readonly seq: number
  }

/** The typed spec as the Host read it, on the installing, installed, and failed screens. */
export interface InstallSubject extends PluginSpecInspection {
  readonly spec: string
}

/** Why the typed spec was refused before anything installed. */
export interface InstallInputError {
  readonly problem: PluginInspectProblem
  readonly reason: string
}

/** One pnpm run of an install, as the dialog's terminal draws it. */
export interface InstallRun {
  readonly jobId: string
  /** The command line the Host ran, space-joined. */
  readonly command: string
  /** The directory the Host ran pnpm in: the profile directory. */
  readonly cwd: string
  /** stdout and stderr interleaved as they arrived, pnpm's colour escapes included. */
  readonly output: string
  /** pnpm's exit code once the run settled, null when it ended by a signal or never started; absent while it runs. */
  readonly exitCode?: number | null
}

/**
 * The install dialog: the spec is typed while `idle`, read by the Host while
 * `checking`, then installed through the Host-owned phases — `starting` until
 * the Host acknowledges the run, `running`, `cancelling` while the Host stops
 * it, `applying` once configuration application closed the cancellation
 * window — and the outcome shown as `done` or `failed`. A refused check, a
 * confirmed cancellation, and the back control return to `idle` with the spec kept.
 */
export interface InstallState {
  readonly open: boolean
  /** The package spec as typed. */
  readonly spec: string
  readonly phase: 'idle' | 'checking' | 'starting' | 'running' | 'cancelling' | 'applying' | 'done' | 'failed'
  /** Identifies this dialog's installation, including log and cancellation messages. */
  readonly requestId?: PluginInstallRequestId
  /** Why the spec was refused before installing; shown under the field. */
  readonly inputError: InstallInputError | null
  /** What the spec names, once the Host has read it. */
  readonly subject: InstallSubject | null
  /** The pnpm runs of the open install, in the order they started. */
  readonly runs: readonly InstallRun[]
  /** Whether the run's command and output are unfolded. */
  readonly detailsOpen: boolean
  /** Dependencies the last run added and kept, once it finished. */
  readonly installed: readonly string[]
  /** Bundles the run installed and left off. */
  readonly installedOnly: readonly string[]
  /** Packages installed without a bundle patch. */
  readonly plain: readonly string[]
  /** Packages pnpm added that the Host removed again, each with its reason. */
  readonly removed: readonly PluginInstallRejection[]
  /** The Host's refusal or the run's failure, once one settled the dialog; `kind` classifies a pnpm failure. */
  readonly failure: { readonly code: string; readonly reason: string; readonly kind?: PluginInstallFailureKind } | null
  /** Enabling the newly installed bundles from the installed screen is crossing the wire. */
  readonly enabling: boolean
}

/**
 * Whether an installation is still owned by the Host.
 * @param phase - the dialog's current installation phase.
 * @returns true until an authoritative result settles the installation.
 */
export function isInstallPending(phase: InstallState['phase']): boolean {
  return phase === 'starting' || phase === 'running' || phase === 'cancelling' || phase === 'applying'
}

/** A destructive action waiting for the user's confirmation: a package's uninstall or disable, or one row's switch-off. */
export type ConfirmState =
  | {
    readonly action: 'uninstall' | 'disable'
    readonly packageName: string
    /** What the action would strand; undefined while the Host is asked. */
    readonly dependents: PluginDependents | undefined
  }
  | {
    readonly action: 'disableRow'
    readonly packageName: string
    /** The row the switch-off targets. */
    readonly rowId: string
    /** The rows injecting what this row provides; undefined while the Host is asked. */
    readonly dependents: PluginDependents | undefined
  }

/** What the tab renders. */
export interface PluginManagerState {
  /** `unavailable` when the Host runs without a profile runtime; `error` keeps the last packages. */
  readonly status: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
  readonly packages: readonly PluginPackageView[]
  /** Package names and row keys with an action crossing the wire. */
  readonly busy: readonly string[]
  readonly notice: ManagerNotice | null
  readonly install: InstallState
  readonly confirm: ConfirmState | null
  /** The package the list scrolls to and marks, once an install enabled it. */
  readonly highlight: string | null
}

/** The registration-side face the tab's slot entry injects. */
export interface PluginManagerFace {
  hooks: {
    /** Tab snapshot bound by the renderer as usePluginManager. */
    pluginManager: SnapshotStore<PluginManagerState>
  }
  /** Read the Host once the tab first renders. */
  ensure: () => void
  /** Read the Host again. */
  refresh: () => void
  openInstall: () => void
  /** Close the dialog; a check in flight is dropped, a Host-owned run has to be cancelled first. */
  closeInstall: () => void
  editInstallSpec: (text: string) => void
  /** Check the spec with the Host, then install it; from the failed screen, run it again. */
  runInstall: () => void
  /** Leave the check or the failed screen for the spec, or ask the Host to stop the run and wait for its cleanup. */
  cancelInstall: () => void
  toggleInstallDetails: () => void
  /** Enable the bundles the finished install added, then close the dialog and mark the first in the list. */
  enableInstalled: () => void
  /** Drop the list mark once it has been shown. */
  clearHighlight: () => void
  /** Put a bundle into, or take it out of, the profile's layer list. */
  setEnabled: (packageName: string, enabled: boolean) => void
  /** Compose an enabled bundle again from scratch. */
  retry: (packageName: string) => void
  /** Ask before removing a package from the profile. */
  uninstall: (packageName: string) => void
  confirm: () => void
  cancelConfirm: () => void
  setRowDisabled: (rowId: string, disabled: boolean) => void
  /** Switch one of a package's rows off in the global layer, after asking when other rows inject what it provides. */
  disableRow: (packageName: string, entryId: string, rowId: string) => void
  dismissNotice: () => void
}

/** A Remote answer as the generated client returns it. */
type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } }

/** One string field of a failure's details, when the details carry it. */
function detailOf(error: { details?: unknown }, field: string): string | undefined {
  const details = error.details
  if (typeof details === 'object' && details !== null && field in details) {
    const value = (details as Record<string, unknown>)[field]
    if (typeof value === 'string') return value
  }
  return undefined
}

/** The exit code a pnpm failure's details carry: a number, null for no exit code, undefined when the details carry none. */
function exitCodeOf(error: { details?: unknown }): number | null | undefined {
  const details = error.details
  if (typeof details === 'object' && details !== null && 'exitCode' in details) {
    const value = (details as Record<string, unknown>).exitCode
    if (typeof value === 'number' || value === null) return value
  }
  return undefined
}

/** The runs with every one still open settled at `exitCode`. */
function settledRuns(runs: readonly InstallRun[], exitCode: number | null): readonly InstallRun[] {
  return runs.map(run => run.exitCode === undefined ? { ...run, exitCode } : run)
}

/** The Host reason a failure carries, when its details name one; else its message. */
function reasonOf(error: { message: string; details?: unknown }): string {
  return detailOf(error, 'reason') ?? error.message
}

/**
 * The key one row occupies in the busy list.
 * @param rowId - the row's id in that layer.
 * @returns the busy key.
 */
export function rowKey(rowId: string): string {
  return `global:${rowId}`
}

const IDLE_INSTALL: InstallState = {
  open: false, spec: '', phase: 'idle', inputError: null, subject: null, runs: [], detailsOpen: false,
  installed: [], installedOnly: [], plain: [], removed: [], failure: null, enabling: false,
}

/** Refusals of an install that are about the moment, not the spec: they toast and leave the spec to try again. */
const TRANSIENT_REFUSALS = new Set(['plugins/busy', 'plugins/agents-running'])

/** Reads and mutates the profile's plugins through the `plugins` Remote. */
export class PluginManagerController {
  private readonly store: SnapshotStore<PluginManagerState>
  private inFlight: Promise<void> | undefined
  private rerun = false
  private generation = 0
  private disposed = false
  private pendingConfirm: (() => Promise<void>) | undefined
  /** Cancels the check the dialog has in flight. */
  private inspectAbort: AbortController | undefined
  private noticeSeq = 0

  /**
   * @param ctx - the tab plugin's context, whose `remote.plugins` namespace answers.
   */
  constructor(
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore<PluginManagerState>({
      status: 'idle', packages: [], busy: [], notice: null,
      install: IDLE_INSTALL, confirm: null, highlight: null,
    })
  }

  /**
   * Read the tab's state.
   * @returns the current sync snapshot (stable reference until the next change).
   */
  getSnapshot(): PluginManagerState {
    return this.store.getSnapshot()
  }

  /** Stop publishing and drop every late settlement. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
  }

  /**
   * Build the face the tab's slot registration injects.
   * @returns the tab's snapshot source and its actions.
   */
  inject(): PluginManagerFace {
    return {
      hooks: { pluginManager: this.store },
      ensure: () => { if (this.getSnapshot().status === 'idle') void this.load() },
      refresh: () => { void this.load() },
      openInstall: () => {
        if (!isInstallPending(this.getSnapshot().install.phase)) this.patch({ install: { ...IDLE_INSTALL, open: true } })
      },
      closeInstall: () => {
        if (isInstallPending(this.getSnapshot().install.phase)) return
        this.abortInspect()
        this.patch({ install: IDLE_INSTALL })
      },
      editInstallSpec: (text) => {
        const install = this.getSnapshot().install
        // Typing while the Host checks or installs is not possible; a new spec after an outcome starts over.
        if (install.phase === 'checking' || isInstallPending(install.phase)) return
        this.patchInstall(install.phase === 'idle' ? { spec: text, inputError: null } : { ...IDLE_INSTALL, open: true, spec: text })
      },
      runInstall: () => { void this.runInstall() },
      cancelInstall: () => { void this.cancelInstall() },
      toggleInstallDetails: () => { this.patchInstall({ detailsOpen: !this.getSnapshot().install.detailsOpen }) },
      enableInstalled: () => { void this.enableInstalled() },
      clearHighlight: () => { if (this.getSnapshot().highlight !== null) this.patch({ highlight: null }) },
      setEnabled: (packageName, enabled) => { void this.setEnabled(packageName, enabled) },
      retry: (packageName) => {
        void this.run(packageName, { packageName }, async () => {
          this.effect(await this.ctx.remote.plugins.retry(packageName), packageName)
        })
      },
      uninstall: (packageName) => { void this.askConfirm('uninstall', packageName) },
      confirm: () => { void this.confirm() },
      cancelConfirm: () => { this.pendingConfirm = undefined; this.patch({ confirm: null }) },
      setRowDisabled: (rowId, disabled) => {
        void this.run(rowKey(rowId), { rowId }, async () => {
          this.answer(await this.ctx.remote.plugins.setRowDisabled(rowId, disabled))
        })
      },
      disableRow: (packageName, entryId, rowId) => { void this.askRowConfirm(packageName, entryId, rowId) },
      dismissNotice: () => { this.patch({ notice: null }) },
    }
  }

  /**
   * Follow the Host's cancellation window for this dialog's installation.
   * @param progress - a request id and phase received from the Host.
   */
  installProgress(progress: PluginInstallProgress): void {
    const install = this.getSnapshot().install
    if (install.requestId !== progress.requestId || !isInstallPending(install.phase)) return
    // A queued start notification cannot undo the local user's cancellation request.
    if (install.phase === 'cancelling' && progress.phase === 'installing') return
    this.patchInstall({ phase: progress.phase === 'installing' ? 'running' : progress.phase })
  }

  /**
   * Fold a chunk belonging to this installation into its pnpm command.
   * A final chunk may arrive after the add response and still updates an existing run.
   * @param chunk - the chunk the Host forwarded.
   */
  appendLog(chunk: PluginInstallLogChunk): void {
    const install = this.getSnapshot().install
    if (chunk.requestId !== install.requestId) return
    const index = install.runs.findIndex(run => run.jobId === chunk.jobId)
    if (index === -1 && !isInstallPending(install.phase)) return
    const settled = chunk.exitCode === undefined ? {} : { exitCode: chunk.exitCode }
    const runs = index === -1
      ? [...install.runs, { jobId: chunk.jobId, command: chunk.argv.join(' '), cwd: chunk.cwd, output: chunk.text, ...settled }]
      : install.runs.map((run, at) => at === index ? { ...run, output: run.output + chunk.text, ...settled } : run)
    this.patchInstall({ runs })
  }

  /**
   * Read the packages and the global composition. A call during an
   * in-flight read marks one rerun after it settles.
   * @returns settlement after this call's freshness is reflected.
   */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inFlight !== undefined) {
      this.rerun = true
      return this.inFlight
    }
    const run = Promise.resolve().then(() => this.read())
    this.inFlight = run
    return run
  }

  private async read(): Promise<void> {
    try {
      do {
        this.rerun = false
        const generation = ++this.generation
        if (this.getSnapshot().status === 'idle') this.patch({ status: 'loading' })
        const packages = await this.ctx.remote.plugins.list()
        if (generation !== this.generation) return
        if (!packages.ok) {
          this.patch({ status: packages.error.code === 'plugins/unavailable' ? 'unavailable' : 'error' })
          continue
        }
        this.patch({
          status: 'ready',
          packages: packages.value,
        })
      } while (this.shouldRerun())
    } finally {
      this.inFlight = undefined
    }
  }

  private shouldRerun(): boolean {
    return this.rerun
  }

  private async setEnabled(packageName: string, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.run(packageName, { packageName }, async () => {
        this.effect(await this.ctx.remote.plugins.enable(packageName), packageName)
      })
      return
    }
    await this.askConfirm('disable', packageName)
  }

  /**
   * Open the confirmation for a destructive action, asking the Host what it
   * would strand. A disable with nothing depending on the bundle needs no
   * confirmation and runs at once; every other confirmation runs its action
   * through `confirm` once the dependents are listed.
   */
  private async askConfirm(action: 'uninstall' | 'disable', packageName: string): Promise<void> {
    const perform = action === 'uninstall'
      ? async (): Promise<void> => {
        this.answer(await this.ctx.remote.plugins.uninstall(packageName))
      }
      : async (): Promise<void> => {
        this.effect(await this.ctx.remote.plugins.disable(packageName), packageName)
      }
    const commit = (): Promise<void> => this.run(packageName, { packageName }, perform)
    if (action === 'uninstall') {
      // Always confirmed: the dialog opens at once and fills in what depends on the package.
      this.pendingConfirm = commit
      this.patch({ confirm: { action, packageName, dependents: undefined } })
      const answer = await this.ctx.remote.plugins.dependents(packageName).catch((): undefined => undefined)
      // Reads run beside this ask (the Host announces changes while it is
      // open), so liveness is the confirmation still being this one.
      const confirm = this.getSnapshot().confirm
      if (this.disposed || confirm?.packageName !== packageName || confirm.action !== action) return
      this.patch({ confirm: { ...confirm, dependents: answer?.ok === true ? answer.value : { services: [], references: [] } } })
      return
    }
    // A disable asks first, with the switch inert, and opens the dialog only
    // for a package something depends on: nothing flashes for one nothing does.
    const value = await this.dependentsOf(packageName, packageName)
    if (value === undefined) return
    if (value.services.length === 0 && value.references.length === 0) {
      await commit()
      return
    }
    this.pendingConfirm = commit
    this.patch({ confirm: { action, packageName, dependents: value } })
  }

  /**
   * Ask before switching one row off: of the package's dependents, the
   * services this row provides that other rows inject. The switch stays
   * inert while the Host answers; a row nothing depends on switches off at
   * once, and only a row something depends on opens the dialog.
   */
  private async askRowConfirm(packageName: string, entryId: string, rowId: string): Promise<void> {
    const key = rowKey(rowId)
    const commit = (): Promise<void> => this.run(key, { rowId }, async () => {
      this.answer(await this.ctx.remote.plugins.setRowDisabled(rowId, true))
    })
    const value = await this.dependentsOf(packageName, key)
    if (value === undefined) return
    const services = value.services.filter(service => service.providedBy === entryId)
    if (services.length === 0) {
      await commit()
      return
    }
    this.pendingConfirm = commit
    this.patch({ confirm: { action: 'disableRow', packageName, rowId, dependents: { services, references: [] } } })
  }

  /**
   * Ask the Host what depends on a package while the control that asked
   * stays inert under `key`, so nothing opens before the answer is known. A
   * refused or failed answer reads as nothing: the check must not stand
   * between the person and the action they asked for, whose own failure
   * would still be reported.
   * @returns the dependents, or undefined when the key is already busy or the controller was disposed meanwhile.
   */
  private async dependentsOf(packageName: string, key: string): Promise<PluginDependents | undefined> {
    if (this.getSnapshot().busy.includes(key)) return undefined
    this.patch({ busy: [...this.getSnapshot().busy, key] })
    const answer = await this.ctx.remote.plugins.dependents(packageName).catch((): undefined => undefined)
    this.patch({ busy: this.getSnapshot().busy.filter(entry => entry !== key) })
    if (this.disposed) return undefined
    return answer?.ok === true ? answer.value : { services: [], references: [] }
  }

  private async confirm(): Promise<void> {
    const pending = this.pendingConfirm
    this.pendingConfirm = undefined
    this.patch({ confirm: null })
    if (pending !== undefined) await pending()
  }

  /** Drop the check in flight; its answer is ignored. */
  private abortInspect(): void {
    this.inspectAbort?.abort()
    this.inspectAbort = undefined
  }

  /** Whether a settlement arrives too late to matter: the store is disposed, or the dialog moved on. */
  private gone(signal: AbortSignal): boolean {
    return this.disposed || signal.aborted
  }

  /**
   * Check the typed spec, then install it. The Host reads what the spec
   * names first; a refused spec returns to the field with the reason, an
   * accepted one becomes the subject the next screens show while pnpm runs.
   */
  private async runInstall(): Promise<void> {
    const state = this.getSnapshot()
    const install = state.install
    const spec = install.spec.trim()
    if (install.phase === 'checking' || isInstallPending(install.phase) || spec === '') return
    // A name the list already shows is refused at once, before the Host is asked.
    if (state.packages.some(pkg => pkg.name === spec)) {
      this.patchInstall({ phase: 'idle', inputError: { problem: 'already-installed', reason: spec } })
      return
    }
    this.abortInspect()
    const controller = new AbortController()
    this.inspectAbort = controller
    this.patchInstall({
      phase: 'checking', inputError: null, subject: null, runs: [], detailsOpen: false,
      installed: [], installedOnly: [], plain: [], removed: [], failure: null,
    })
    const inspected = await this.ctx.remote.plugins.inspect(spec, controller.signal)
    if (this.gone(controller.signal)) return
    this.inspectAbort = undefined
    if (!inspected.ok) {
      const problem = detailOf(inspected.error, 'problem')
      this.patchInstall({
        phase: 'idle',
        inputError: { problem: isInspectProblem(problem) ? problem : 'unknown', reason: reasonOf(inspected.error) },
      })
      return
    }
    const requestId = randomUUID() as PluginInstallRequestId
    this.patchInstall({ phase: 'starting', requestId, subject: { spec, ...inspected.value } })
    // The Host announces `plugins/changed` while the run is still on the
    // wire, and every such event reads again; those reads must not cancel
    // the run's settlement.
    const result = await this.ctx.remote.plugins.add(spec, { requestId })
    if (this.disposed || this.getSnapshot().install.requestId !== requestId) return
    // A run whose last chunk never reached the dialog settles from the answer:
    // a finished install, and a refusal that followed pnpm — a bundle the tree
    // rejected — both mean every run exited 0, and a pnpm failure names the
    // code the failing run exited with.
    const runs = this.getSnapshot().install.runs
    if (result.ok) {
      this.patchInstall({ phase: 'done', runs: settledRuns(runs, 0), ...outcomeOf(result.value) })
    } else if (result.error.code === 'plugins/install-cancelled') {
      this.offerSpecAgain({ kind: 'cancelled', seq: ++this.noticeSeq })
    } else if (TRANSIENT_REFUSALS.has(result.error.code)) {
      // The moment refused, not the spec: say so in passing and keep the spec to try again.
      this.offerSpecAgain(this.failedNotice(result.error, {}))
    } else {
      const reason = detailOf(result.error, 'reason') ?? detailOf(result.error, 'log') ?? result.error.message
      const kind = detailOf(result.error, 'kind')
      const exitCode = result.error.code === 'plugins/install-failed' ? exitCodeOf(result.error) ?? null : 0
      this.patchInstall({
        phase: 'failed',
        runs: settledRuns(runs, exitCode),
        failure: { code: result.error.code, reason, ...isFailureKind(kind) ? { kind } : {} },
      })
    }
    void this.load()
  }

  /**
   * Leave the check or the failed screen for the spec at once; a Host-owned
   * run is asked to stop and the dialog waits for the Host's word, since
   * neither a dropped RPC nor a closed connection means pnpm has stopped.
   */
  private async cancelInstall(): Promise<void> {
    const install = this.getSnapshot().install
    if (install.phase === 'checking' || install.phase === 'failed') {
      this.abortInspect()
      this.offerSpecAgain()
      return
    }
    if (install.phase !== 'running' || install.requestId === undefined) return
    const requestId = install.requestId
    this.patchInstall({ phase: 'cancelling', failure: null })
    const result = await this.ctx.remote.plugins.cancelInstall(requestId)
    const current = this.getSnapshot().install
    if (this.disposed || current.requestId !== requestId || !isInstallPending(current.phase)) return
    if (!result.ok) {
      this.patchInstall({ phase: 'running', failure: { code: 'client/cancel-unconfirmed', reason: result.error.message } })
      return
    }
    if (result.value.status === 'cancelled') {
      this.offerSpecAgain({ kind: 'cancelled', seq: ++this.noticeSeq })
      void this.load()
    } else if (result.value.status === 'too-late') {
      this.patchInstall({ phase: 'applying' })
    } else {
      this.patchInstall({ phase: 'running', failure: { code: 'client/cancel-unconfirmed', reason: '' } })
    }
  }

  /**
   * Back to the spec: the check, the run, and its request are forgotten and
   * the spec is kept, with a toast when there is something to say — the Host
   * stopped the run, or the moment refused it.
   */
  private offerSpecAgain(notice: ManagerNotice | null = null): void {
    const { open, spec } = this.getSnapshot().install
    this.patch({ install: { ...IDLE_INSTALL, open, spec }, ...notice === null ? {} : { notice } })
  }

  /**
   * Enable every bundle the finished install added, one after the other, then
   * close the dialog and mark the first of them in the list. A refusal toasts
   * and still closes: the list shows what did and did not switch on.
   */
  private async enableInstalled(): Promise<void> {
    const install = this.getSnapshot().install
    if (install.phase !== 'done' || install.enabling) return
    this.patchInstall({ enabling: true })
    for (const name of install.installedOnly) {
      const result = await this.ctx.remote.plugins.enable(name)
      if (this.disposed) return
      if (!result.ok) {
        this.patch({ notice: this.failedNotice(result.error, { packageName: name }) })
        break
      }
      if (result.value.effect === 'restart') this.patch({ notice: { kind: 'restart', packageName: name, seq: ++this.noticeSeq } })
    }
    this.patch({ install: IDLE_INSTALL, highlight: install.installedOnly[0] ?? null })
    await this.load()
  }

  /** The toast a refused answer becomes. */
  private failedNotice(
    error: { code: string; message: string; details?: unknown },
    subject: { packageName?: string; rowId?: string },
  ): ManagerNotice {
    return { kind: 'failed', code: error.code, reason: reasonOf(error), ...subject, seq: ++this.noticeSeq }
  }

  /**
   * Run one action under a busy key, turn its failure into the notice, and
   * re-read the Host afterwards whatever happened.
   */
  private async run(
    key: string,
    subject: { packageName?: string; rowId?: string },
    action: () => Promise<void>,
  ): Promise<void> {
    if (this.disposed || this.getSnapshot().busy.includes(key)) return
    this.patch({ busy: [...this.getSnapshot().busy, key], notice: null })
    try {
      await action()
    } catch (error) {
      // `patch` drops the notice after disposal; a refused answer carries the
      // Host's code, anything else is a transport failure.
      const failure = error instanceof RemoteAnswerError
        ? error
        : new RemoteAnswerError('gateway/internal', error instanceof Error ? error.message : String(error))
      this.patch({ notice: { kind: 'failed', code: failure.code, reason: failure.reason, ...subject, seq: ++this.noticeSeq } })
    } finally {
      this.patch({ busy: this.getSnapshot().busy.filter(entry => entry !== key) })
    }
    await this.load()
  }

  /** Publish an enable-shaped answer's effect as the notice. */
  private effect(result: Answer<PluginEnableResult>, packageName: string): void {
    const value = this.answer(result)
    // Success needs no notice: the re-read list shows the new state. A restart the change waits for does.
    if (value.effect === 'restart') this.patch({ notice: { kind: 'restart', packageName, seq: ++this.noticeSeq } })
  }

  /** Unwrap an answer, throwing its failure for {@link run} to report. */
  private answer<T>(result: Answer<T>): T {
    if (result.ok) return result.value
    throw new RemoteAnswerError(result.error.code, reasonOf(result.error))
  }

  private patch(next: Partial<PluginManagerState>): void {
    if (this.disposed) return
    this.store.set({ ...this.getSnapshot(), ...next })
  }

  private patchInstall(next: Partial<InstallState>): void {
    this.patch({ install: { ...this.getSnapshot().install, ...next } })
  }
}

/** The lists one finished install run reports, as the dialog's state carries them. */
function outcomeOf(result: PluginInstallResult): Pick<InstallState, 'installed' | 'installedOnly' | 'plain' | 'removed'> {
  return {
    installed: result.installed,
    installedOnly: result.installedOnly,
    plain: result.plain,
    removed: result.removed,
  }
}

const INSPECT_PROBLEMS: readonly PluginInspectProblem[] = ['invalid-spec', 'already-installed', 'not-found', 'not-a-package', 'network', 'unknown']
const FAILURE_KINDS: readonly PluginInstallFailureKind[] = [
  'pnpm-missing', 'timeout', 'not-found', 'no-matching-version', 'network', 'disk-full', 'permission', 'build-blocked', 'integrity', 'unknown',
]

function isInspectProblem(value: string | undefined): value is PluginInspectProblem {
  return value !== undefined && (INSPECT_PROBLEMS as readonly string[]).includes(value)
}

function isFailureKind(value: string | undefined): value is PluginInstallFailureKind {
  return value !== undefined && (FAILURE_KINDS as readonly string[]).includes(value)
}

/** A refused Remote answer, carried to the notice with the Host's code and reason. */
class RemoteAnswerError extends Error {
  constructor(readonly code: string, readonly reason: string) {
    super(reason)
  }
}
