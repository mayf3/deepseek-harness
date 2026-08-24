/** User control for model-selectable subagent delegation in new sessions. */

import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentModelSelectionCardFace } from './subagent-model-selection-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './SubagentModelSelectionCard.module.css'

/** Props the renderer binds for the subagent model-selection card. */
export type SubagentModelSelectionCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SubagentModelSelectionCardFace>

/**
 * Render the default-off preference and persist each switch gesture.
 * @param props - locale copy, the card snapshot, and its toggle action.
 * @returns the preference card, or nothing when the namespace is unavailable.
 */
export function SubagentModelSelectionCard(props: SubagentModelSelectionCardProps) {
  const { t } = props
  const state = props.useSubagentModelSelectionCard(snapshot => snapshot)
  if (!state.available) return null
  return (
    <li className={css.card} aria-labelledby="subagent-model-selection-title">
      <div className={css.copy}>
        <h3 id="subagent-model-selection-title" className={css.title}>
          {t('subagentModelSelectionTitle')}
        </h3>
        <p className={css.description}>{t('subagentModelSelectionDescription')}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={state.enabled}
        aria-label={t('subagentModelSelectionToggle')}
        className={clsx(css.switch, state.enabled && css.switchOn)}
        disabled={!state.writable || state.saving}
        onClick={props.toggle}
      >
        <span className={css.thumb} />
      </button>
      {state.saved ? <p className={css.status} role="status">{t('subagentModelSelectionSaved')}</p> : null}
      {state.failed ? <p className={css.failed} role="alert">{t('subagentModelSelectionSaveFailed')}</p> : null}
    </li>
  )
}
