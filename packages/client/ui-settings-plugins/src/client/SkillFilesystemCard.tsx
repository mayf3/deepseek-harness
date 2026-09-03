/** The filesystem skill provider's card: the extra roots the agent discovers skills in. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { SkillFilesystemCardFace } from './skill-filesystem-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the skill roots card. */
export type SkillFilesystemCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SkillFilesystemCardFace>

/**
 * Render the skill roots card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function SkillFilesystemCard(props: SkillFilesystemCardProps) {
  const { t } = props
  const state = props.useSkillFilesystemCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="skillFilesystemTitle"
      descriptionKey="skillFilesystemDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-skill-filesystem-dirs"
        label={t('skillFilesystemCustomSkillDirs')}
        hint={t('skillFilesystemCustomSkillDirsHint')}
        overriddenLabel={t('overridden')}
        inheritedLabel={t('inherited')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        multiline
        disabled={!state.writable}
        {...state.customSkillDirs}
        onEdit={(text) => { props.edit('customSkillDirs', text) }}
        onReset={() => { props.resetField('customSkillDirs') }}
      />
    </PluginCard>
  )
}
