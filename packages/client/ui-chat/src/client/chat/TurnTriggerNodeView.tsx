/** An independent, expandable notice explaining a non-human Turn trigger. */
import { useId, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { contextBody } from './ContextBody.tsx'
import { turnTriggerDetails } from './turn-trigger.ts'
import css from './TurnTriggerNodeView.module.css'

/** Render recorded trigger attribution above the whole-Turn disclosure. */
export function TurnTriggerNodeView({ node, t }: ChatNodeViewProps<'turn-trigger'>) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const details = turnTriggerDetails(node.data)
  const detailBody = contextBody(null, { content: node.data.content, source: node.data.source, t }).body
  const date = new Date(node.data.time)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return (
    <section className={css.root} data-turn-trigger>
      <button className={css.header} type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => { setOpen(!open) }}>
        <svg className={css.icon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4M3 4 1 7m20-3 2 3" />
        </svg>
        <span className={css.title}>{t(details.title)}</span>
        {details.subject !== '' && <span className={css.subject}>· {details.subject}</span>}
        <time className={css.time} dateTime={date.toISOString()}>{time}</time>
        <IconChevronDownOutline14 className={open ? css.openChevron : css.chevron} />
      </button>
      {open && <div id={bodyId} className={css.body}>
        <div className={css.metadata}>{details.producer}</div>
        <p className={css.explanation}>{t('message.trigger.explanation')}</p>
        <div className={css.content}>{detailBody}</div>
      </div>}
    </section>
  )
}
