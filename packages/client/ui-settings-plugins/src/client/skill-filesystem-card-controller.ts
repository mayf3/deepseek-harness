/** The skill roots card's staged form over the `skill-filesystem` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { linesField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'
import { ScopedCardForms, type BindScope, type ScopeSelection } from './scoped-form.ts'

/**
 * Namespace of the filesystem skill provider. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const SKILL_FILESYSTEM_NS = 'skill-filesystem'

/** The skill-provider fields this card edits. */
export interface SkillFilesystemSettings {
  /** Extra skill roots scanned after the built-in ones. */
  customSkillDirs?: string[]
}

/** What the skill roots card renders. */
export interface SkillFilesystemCardState extends CardShell {
  /** Extra skill roots, one per line. */
  customSkillDirs: CardFieldState
}

/** The registration-side face the skill roots card's slot entry injects. */
export interface SkillFilesystemCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useSkillFilesystemCard. */
    skillFilesystemCard: SnapshotStore<SkillFilesystemCardState>
  }
}

/** Bridges the `skill-filesystem` namespace, under the selected scope, onto the card's staged form. */
export class SkillFilesystemCardController {
  private readonly form: ScopedCardForms<SkillFilesystemSettings>
  private readonly store: SnapshotStore<SkillFilesystemCardState>

  /**
   * @param selection - the scope selection shared with the tab.
   * @param bindScope - binds the `skill-filesystem` namespace under one scope.
   */
  constructor(selection: ScopeSelection, bindScope: BindScope<SkillFilesystemSettings>) {
    this.form = new ScopedCardForms(selection, bindScope, [linesField('customSkillDirs')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): SkillFilesystemCardState {
    return { ...this.form.shell(), customSkillDirs: this.form.field('customSkillDirs') }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): SkillFilesystemCardFace {
    return { hooks: { skillFilesystemCard: this.store }, ...this.form.actions() }
  }
}
