/** One settings card for Subagent delegation limits and model authorization. */

import { useId } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import { PluginCard } from './PluginCard.tsx'
import { SubagentLimitsFields } from './SubagentLimitsFields.tsx'
import { SubagentModelSelectionFields } from './SubagentModelSelectionFields.tsx'
import { subagentCardShell, type SubagentCardFace } from './subagent-card-controller.ts'
import css from './SubagentCard.module.css'

/** Framework-derived props for the shared Subagent settings card. */
export type SubagentCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'> & InjectFace<SubagentCardFace>

/**
 * Render the available Subagent settings with one disclosure and save footer.
 * @param props - Locale, both form snapshots, and their shared actions.
 * @returns One card; the fallback stays hidden when the primary namespace is available.
 */
export function SubagentCard(props: SubagentCardProps) {
  const { t } = props
  const limits = props.useSubagentLimitsCard(snapshot => snapshot)
  const models = props.useSubagentModelSelectionCard(snapshot => snapshot)
  const headingId = useId()
  if (props.fallback && limits.available) return null
  const state = subagentCardShell(limits, models)
  return (
    <PluginCard t={t} titleKey="subagentTitle" descriptionKey="subagentDescription"
      state={state} onSave={props.save} onDiscard={props.discard}>
      {limits.available
        ? (
          <section className={css.section} aria-labelledby={`${headingId}-limits`}>
            <h3 className={css.heading} id={`${headingId}-limits`}>{t('subagentLimitsTitle')}</h3>
            <SubagentLimitsFields t={t} state={{ ...limits, saving: state.saving }}
              edit={props.editLimit} resetField={props.resetLimit} />
          </section>
        )
        : null}
      {models.available
        ? (
          <section className={css.section} aria-labelledby={`${headingId}-models`}>
            <h3 className={css.heading} id={`${headingId}-models`}>{t('subagentModelSelectionTitle')}</h3>
            <SubagentModelSelectionFields t={t} state={{ ...models, saving: state.saving }}
              toggleEnabled={props.toggleEnabled} toggleModel={props.toggleModel} retryCatalog={props.retryCatalog} />
          </section>
        )
        : null}
    </PluginCard>
  )
}
