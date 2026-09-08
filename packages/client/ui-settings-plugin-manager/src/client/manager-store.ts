/**
 * The plugin manager's state, shared by the Manage plugins tab and the
 * capabilities section of a preset's detail page: the Host's package views
 * and preset compositions, the action in flight, the install run, and the
 * confirmation a destructive action waits on. Every fact comes from the Host — the store
 * re-reads after each action and after every `plugins/changed` event, so a
 * change made on another surface shows here without a manual refresh.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  PluginDependents,
  PluginEnableResult,
  PluginInstallLogChunk,
  PluginInstallRejection,
  PluginInstallResult,
  PluginInventorySnapshot,
  PluginPackageView,
  PluginRowTarget,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** One preset composition as the inventory reports it, with its rows. */
export type PresetGroup = NonNullable<PluginInventorySnapshot['agentPresets']>[number]

/** One row of a preset composition. */
export type PresetRow = PresetGroup['rows'][number]

/** What the last action left to say. */
export type ManagerNotice =
  | { readonly kind: 'restart'; readonly packageName: string }
  | {
    readonly kind: 'failed'
    /** The Host's failure code, which selects the copy. */
    readonly code: string
    /** The Host's reason, shown verbatim. */
    readonly reason: string
    readonly packageName?: string
    readonly rowId?: string
  }

/** The install dialog. */
export interface InstallState {
  readonly open: boolean
  /** The package spec as typed. */
  readonly spec: string
  /** Whether a newly installed bundle is enabled right away. */
  readonly enable: boolean
  readonly phase: 'idle' | 'running' | 'done' | 'failed'
  /** pnpm's output so far, stdout and stderr interleaved as they arrived. */
  readonly log: string
  /** Dependencies the last run added and kept, once it finished. */
  readonly installed: readonly string[]
  /** Bundles the run enabled at once. */
  readonly enabled: readonly string[]
  /** Bundles the run installed and left off. */
  readonly installedOnly: readonly string[]
  /** Plugin modules the run installed, which join a composition per row. */
  readonly plain: readonly string[]
  /** Packages pnpm added that the Host removed again, each with its reason. */
  readonly removed: readonly PluginInstallRejection[]
  /** The Host's refusal, when the run failed before or after pnpm. */
  readonly failure: { readonly code: string; readonly reason: string } | null
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
  readonly presets: readonly PresetGroup[]
  /** Module names of the rows the host tree carries, for the **Add to…** menu's "added" marks. */
  readonly globalModules: readonly string[]
  /** Package names and row keys with an action crossing the wire. */
  readonly busy: readonly string[]
  readonly notice: ManagerNotice | null
  readonly install: InstallState
  readonly confirm: ConfirmState | null
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
  closeInstall: () => void
  editInstallSpec: (text: string) => void
  toggleInstallEnable: () => void
  runInstall: () => void
  /** Put a bundle into, or take it out of, the profile's layer list. */
  setEnabled: (packageName: string, enabled: boolean) => void
  /** Compose an enabled bundle again from scratch. */
  retry: (packageName: string) => void
  /** Ask before removing a package from the profile. */
  uninstall: (packageName: string) => void
  confirm: () => void
  cancelConfirm: () => void
  /** Add a row naming one of a package's modules — by its declared name, `.` for the main export — to a user layer. */
  addRow: (packageName: string, declaredName: string, target: PluginRowTarget) => void
  removeRow: (target: PluginRowTarget, rowId: string) => void
  setRowDisabled: (target: PluginRowTarget, rowId: string, disabled: boolean) => void
  /** Switch one of a package's rows off in the global layer, after asking when other rows inject what it provides. */
  disableRow: (packageName: string, entryId: string, rowId: string) => void
  dismissNotice: () => void
  /** Display name for one preset, resolved through the agent-preset dictionaries. */
  presetName: (preset: PresetGroup) => string
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

/** The Host reason a failure carries, when its details name one; else its message. */
function reasonOf(error: { message: string; details?: unknown }): string {
  return detailOf(error, 'reason') ?? error.message
}

/**
 * The key one row occupies in the busy list.
 * @param target - the layer the row lives in.
 * @param rowId - the row's id in that layer.
 * @returns the busy key.
 */
export function rowKey(target: PluginRowTarget, rowId: string): string {
  return `${target.kind === 'global' ? 'global' : `preset:${target.preset}`}:${rowId}`
}

const IDLE_INSTALL: InstallState = {
  open: false, spec: '', enable: true, phase: 'idle', log: '', installed: [], enabled: [], installedOnly: [], plain: [], removed: [], failure: null,
}

/** Reads and mutates the profile's plugins through the `plugins` and `pluginInventory` Remotes. */
export class PluginManagerController {
  private readonly store: SnapshotStore<PluginManagerState>
  private inFlight: Promise<void> | undefined
  private rerun = false
  private generation = 0
  private disposed = false
  private pendingConfirm: (() => Promise<void>) | undefined

  /**
   * @param ctx - the tab plugin's context, whose `remote.plugins` and
   * `remote.pluginInventory` namespaces answer.
   * @param presetName - display name for one preset.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly presetName: (preset: PresetGroup) => string,
  ) {
    this.store = createSnapshotStore<PluginManagerState>({
      status: 'idle', packages: [], presets: [], globalModules: [], busy: [], notice: null,
      install: IDLE_INSTALL, confirm: null,
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
      openInstall: () => { this.patch({ install: { ...IDLE_INSTALL, open: true } }) },
      closeInstall: () => {
        if (this.getSnapshot().install.phase === 'running') return
        this.patch({ install: IDLE_INSTALL })
      },
      editInstallSpec: (text) => { this.patchInstall({ spec: text }) },
      toggleInstallEnable: () => { this.patchInstall({ enable: !this.getSnapshot().install.enable }) },
      runInstall: () => { void this.runInstall() },
      setEnabled: (packageName, enabled) => { void this.setEnabled(packageName, enabled) },
      retry: (packageName) => {
        void this.run(packageName, { packageName }, async () => {
          this.effect(await this.ctx.remote.plugins.retry(packageName), packageName)
        })
      },
      uninstall: (packageName) => { void this.askConfirm('uninstall', packageName) },
      confirm: () => { void this.confirm() },
      cancelConfirm: () => { this.pendingConfirm = undefined; this.patch({ confirm: null }) },
      addRow: (packageName, declaredName, target) => {
        void this.run(packageName, { packageName }, async () => {
          this.answer(await this.ctx.remote.plugins.addRow(packageName, target, { module: declaredName }))
        })
      },
      removeRow: (target, rowId) => {
        void this.run(rowKey(target, rowId), { rowId }, async () => {
          this.answer(await this.ctx.remote.plugins.removeRow(target, rowId))
        })
      },
      setRowDisabled: (target, rowId, disabled) => {
        void this.run(rowKey(target, rowId), { rowId }, async () => {
          this.answer(await this.ctx.remote.plugins.setRowDisabled(target, rowId, disabled))
        })
      },
      disableRow: (packageName, entryId, rowId) => { void this.askRowConfirm(packageName, entryId, rowId) },
      dismissNotice: () => { this.patch({ notice: null }) },
      presetName: this.presetName,
    }
  }

  /**
   * Fold one install-log chunk into the open run. A chunk for another spec —
   * a CLI install running beside the page — is not this dialog's output.
   * @param chunk - the chunk the Host forwarded.
   */
  appendLog(chunk: PluginInstallLogChunk): void {
    const install = this.getSnapshot().install
    if (install.phase !== 'running' || chunk.spec !== install.spec.trim()) return
    this.patchInstall({ log: install.log + chunk.text })
  }

  /**
   * Read the packages and the preset compositions. A call during an
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
        const [packages, inventory] = await Promise.all([
          this.ctx.remote.plugins.list(),
          this.ctx.remote.pluginInventory.list(),
        ])
        if (generation !== this.generation) return
        if (!packages.ok) {
          this.patch({ status: packages.error.code === 'plugins/unavailable' ? 'unavailable' : 'error' })
          continue
        }
        this.patch({
          status: 'ready',
          packages: packages.value,
          presets: inventory.ok ? inventory.value.agentPresets ?? [] : this.getSnapshot().presets,
          globalModules: inventory.ok ? inventory.value.entries.map(entry => entry.moduleName) : this.getSnapshot().globalModules,
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
    const target: PluginRowTarget = { kind: 'global' }
    const key = rowKey(target, rowId)
    const commit = (): Promise<void> => this.run(key, { rowId }, async () => {
      this.answer(await this.ctx.remote.plugins.setRowDisabled(target, rowId, true))
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

  private async runInstall(): Promise<void> {
    const install = this.getSnapshot().install
    const spec = install.spec.trim()
    if (install.phase === 'running' || spec === '') return
    this.patchInstall({ phase: 'running', log: '', installed: [], enabled: [], installedOnly: [], plain: [], removed: [], failure: null })
    // The Host announces `plugins/changed` while the run is still on the
    // wire — enabling recomposes before the call answers — and every such
    // event reads again; those reads must not cancel the run's settlement.
    const result = await this.ctx.remote.plugins.add(spec, { enable: install.enable })
    if (this.disposed) return
    if (result.ok) {
      this.patchInstall({ phase: 'done', ...outcomeOf(result.value) })
    } else {
      // The Host's reason follows whatever streamed: pnpm's captured log when
      // no chunk arrived, else the refusal that followed a successful pnpm
      // run — a bundle the tree rejected, a probe that refused it.
      const current = this.getSnapshot().install.log
      const reason = detailOf(result.error, 'reason') ?? detailOf(result.error, 'log') ?? result.error.message
      const log = current === '' || current.endsWith(reason) ? (current === '' ? reason : current) : `${current}\n${reason}`
      this.patchInstall({ phase: 'failed', log, failure: { code: result.error.code, reason } })
    }
    void this.load()
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
      this.patch({ notice: { kind: 'failed', code: failure.code, reason: failure.reason, ...subject } })
    } finally {
      this.patch({ busy: this.getSnapshot().busy.filter(entry => entry !== key) })
    }
    await this.load()
  }

  /** Publish an enable-shaped answer's effect as the notice. */
  private effect(result: Answer<PluginEnableResult>, packageName: string): void {
    const value = this.answer(result)
    // Success needs no notice: the re-read list shows the new state. A restart the change waits for does.
    if (value.effect === 'restart') this.patch({ notice: { kind: 'restart', packageName } })
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
function outcomeOf(result: PluginInstallResult): Pick<InstallState, 'installed' | 'enabled' | 'installedOnly' | 'plain' | 'removed'> {
  return {
    installed: result.installed,
    enabled: result.enabled,
    installedOnly: result.installedOnly,
    plain: result.plain,
    removed: result.removed,
  }
}

/** A refused Remote answer, carried to the notice with the Host's code and reason. */
class RemoteAnswerError extends Error {
  constructor(readonly code: string, readonly reason: string) {
    super(reason)
  }
}
