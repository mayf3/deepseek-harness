/**
 * The scope a card edits, and the per-scope forms behind one card.
 *
 * The configurable tab offers one scope switch over every card: the global
 * instance, or one agent preset's named scope. A card controller stages
 * edits through {@link ScopedCardForms}, which keeps one {@link CardForm} per
 * scope — drafts belong to the scope they were typed under and survive a
 * switch — and re-projects the selected scope's form whenever the selection
 * or that form moves. Card components stay unaware of scopes: they read the
 * same hooks and call the same actions, which route to the selected form at
 * call time.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CardForm, type CardActions, type CardFieldSpec, type CardFieldState, type CardSecretSpec, type CardShell,
} from './card-form.ts'

/** The scope the configurable tab is editing. */
export interface ScopeSelectionState {
  /** The named settings scope, such as `preset/<id>`; undefined for the global instance. */
  scope: string | undefined
}

/** Map key of the global instance inside {@link ScopedCardForms}. */
const GLOBAL_KEY = ''

/** The one scope selection the configurable tab and every card share. */
export class ScopeSelection {
  private readonly store = createSnapshotStore<ScopeSelectionState>({ scope: undefined })

  /**
   * Read the selection.
   * @returns the current selection (stable reference until the next change).
   */
  getSnapshot(): ScopeSelectionState {
    return this.store.getSnapshot()
  }

  /**
   * Observe selection changes.
   * @param listener - invoked after each change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * The selected scope.
   * @returns the scope id; undefined for the global instance.
   */
  current(): string | undefined {
    return this.store.getSnapshot().scope
  }

  /**
   * Select the scope every card edits.
   * @param scope - a named scope, or undefined for the global instance.
   */
  select(scope: string | undefined): void {
    if (scope === this.current()) return
    this.store.set({ scope })
  }
}

/** Bind one namespace under one scope; the caller's settings-scope binder supplies it. */
export type BindScope<T> = (scope: string | undefined) => SettingsScope<T>

/**
 * One card's forms across scopes, presenting the selected scope's form.
 *
 * A form is bound the first time its scope is selected and kept for the
 * page's lifetime; the global form is bound at once, because the card's
 * availability is read from it before any switch.
 */
export class ScopedCardForms<T> {
  private readonly forms = new Map<string, CardForm<T>>()
  private readonly listeners = new Set<() => void>()

  /**
   * @param selection - the scope selection shared with the tab.
   * @param bindScope - binds the card's namespace under one scope.
   * @param specs - the section fields the card edits.
   * @param secrets - the card's write-only controls, written outside the section.
   */
  constructor(
    private readonly selection: ScopeSelection,
    private readonly bindScope: BindScope<T>,
    private readonly specs: CardFieldSpec[],
    private readonly secrets: CardSecretSpec[] = [],
  ) {
    this.formFor(undefined)
    selection.subscribe(() => {
      this.formFor(selection.current())
      this.publish()
    })
  }

  /**
   * The scope the presented form edits.
   * @returns the scope id; undefined for the global instance.
   */
  scopeId(): string | undefined {
    return this.selection.current()
  }

  /**
   * The selected scope's settings scope, for reads and writes outside the staged form.
   * @returns the bound settings scope of the presented form.
   */
  scope(): SettingsScope<T> {
    return this.current().scopeOf()
  }

  /**
   * Observe the selected form: a scope switch, a Host acceptance, or a draft change.
   * @param listener - invoked after each change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Publish a projection of the selected form, rebuilt whenever it moves.
   * @param project - build the card's state from the current reads.
   * @returns the store the card's component reads through its bound selector.
   */
  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createSnapshotStore(project())
    this.subscribe(() => { store.set(project()) })
    return store
  }

  /**
   * Read the selected form's card-level state.
   * @returns the form state every card shares.
   */
  shell(): CardShell {
    return this.current().shell()
  }

  /**
   * Read one control's state under the selected scope. Under a named scope a
   * field this scope does not override reports whether the GLOBAL user layer
   * carries it, so the control can say the value is inherited.
   * @param field - field name of a section field or of a write-only control.
   * @returns the draft text, its override, inheritance, and validity.
   */
  field(field: string): CardFieldState {
    const state = this.current().field(field)
    if (this.scopeId() === undefined || state.overridden) return state
    return { ...state, inherited: this.global().hasOverride(field) }
  }

  /**
   * Build the edit, reset, save, and discard actions. Each routes to the form
   * selected when it is invoked, not when the actions were built.
   * @returns the actions a card's slot entry injects.
   */
  actions(): CardActions {
    return {
      edit: (field, text) => { this.current().actions().edit(field, text) },
      resetField: (field) => { this.current().actions().resetField(field) },
      save: () => { void this.save() },
      discard: () => { this.current().actions().discard() },
    }
  }

  /**
   * Write the selected form's staged edits.
   * @returns settlement after every write and the read-back.
   */
  save(): Promise<void> {
    return this.current().save()
  }

  private current(): CardForm<T> {
    return this.formFor(this.selection.current())
  }

  private global(): CardForm<T> {
    return this.formFor(undefined)
  }

  private formFor(scope: string | undefined): CardForm<T> {
    const key = scope ?? GLOBAL_KEY
    let form = this.forms.get(key)
    if (form === undefined) {
      form = new CardForm(this.bindScope(scope), this.specs, this.secrets)
      this.forms.set(key, form)
      form.subscribe(() => {
        if (this.selection.current() === scope) this.publish()
      })
    }
    return form
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
