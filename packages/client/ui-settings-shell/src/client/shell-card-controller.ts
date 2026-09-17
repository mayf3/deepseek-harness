/** The shell page's staged form over the `shell` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the shell capability. Spelled here rather than imported: a
 * client package must not depend on a Host package, and the executor families
 * that own it spell the same value.
 */
export const SHELL_NS = 'shell'

/** The shell fields this page edits — a subset of the served schema by design. */
export interface ShellSettings {
  /** Foreground command timeout in milliseconds. */
  timeoutMs?: number
  /** Per-stream in-memory output cap in bytes. */
  maxOutputBytes?: number
}

/** What the shell page renders. */
export interface ShellCardState extends SettingsFormShell {
  /** Command timeout in milliseconds. */
  timeoutMs: SettingsFieldState
  /** Per-stream output cap in bytes. */
  maxOutputBytes: SettingsFieldState
}

/** The registration-side face the shell page's slot entry injects. */
export interface ShellCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useShellCard. */
    shellCard: SnapshotStore<ShellCardState>
  }
}

/** Bridges the `shell` scope onto the page's staged form. */
export class ShellCardController {
  private readonly form: SettingsFormModel<ShellSettings>
  private readonly store: SnapshotStore<ShellCardState>

  /** @param scope - the bound settings scope for the `shell` namespace. */
  constructor(scope: SettingsFormScope<ShellSettings>) {
    this.form = new SettingsFormModel(scope, [settingsNumberField('timeoutMs'), settingsNumberField('maxOutputBytes')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ShellCardState {
    return {
      ...this.form.shell(),
      timeoutMs: this.form.field('timeoutMs'),
      maxOutputBytes: this.form.field('maxOutputBytes'),
    }
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): ShellCardFace {
    return { hooks: { shellCard: this.store }, ...this.form.actions() }
  }
}
