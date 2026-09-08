/** Minimal global panel and its sidebar icon, composed through separate slots. */
import { IconGlobeOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './HelloWorldPanel.module.css'

/**
 * Render the Hello World navigation icon; the sidebar owns the button and label.
 * @param props - framework-composed panel icon props.
 * @returns the globe glyph.
 */
export function HelloWorldIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconGlobeOutline14 size={size} />
}

/**
 * Render a root-scoped panel independent of the selected Session.
 * @param props - main slot props and the sidebar locale seat.
 * @returns the global panel content.
 */
export function HelloWorldPanel({ t }: PropsRuntime<'main'> & PropsLocale<'sidebar'>) {
  return (
    <section className={css.root}>
      <span className={css.icon} aria-hidden="true"><IconGlobeOutline14 size={32} /></span>
      <h1 className={css.title}>{t('panel.helloWorld.title')}</h1>
      <p className={css.description}>{t('panel.helloWorld.description')}</p>
    </section>
  )
}
