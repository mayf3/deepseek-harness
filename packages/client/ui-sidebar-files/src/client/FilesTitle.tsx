/**
 * The files type's chip title: the folder sheet before the type's label.
 * Registered under `sidebar.right.pane.tab.title`; without it the chip would
 * show the bare label. The tree in the body draws its own row glyphs and never
 * this one.
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './FilesBody.module.css'

/** The folder: a 28-unit sheet in the folder colour, a white tab line across it. */
function FolderGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 28 28" fill="none" aria-hidden="true" className={css.titleIcon}>
      <path
        d="M1.40234 9.66489C1.40234 8.89627 1.40234 8.51197 1.46125 8.15149C1.61126 7.2335 2.04206 6.38455 2.69437 5.72144C2.95052 5.46106 3.26068 5.23414 3.88101 4.78031C4.20493 4.54333 4.36689 4.42484 4.53696 4.32686C4.96871 4.07811 5.4474 3.9217 5.94272 3.86753C6.13784 3.84619 6.33851 3.84619 6.73986 3.84619H11.3625C12.2767 3.84619 12.7338 3.84619 13.1688 3.95634C13.3131 3.99288 13.455 4.03833 13.5937 4.09244C14.0117 4.25555 14.3837 4.52115 15.1278 5.05235L16.5476 6.06601C16.8731 6.29841 17.0359 6.41461 17.2187 6.48597C17.2794 6.50964 17.3415 6.52953 17.4046 6.54551C17.5949 6.5937 17.7949 6.5937 18.1949 6.5937H20.5273C23.0584 6.5937 24.3239 6.5937 25.2111 7.23827C25.4976 7.44644 25.7496 7.69841 25.9578 7.98493C26.6023 8.8721 26.6023 10.1376 26.6023 12.6687V19.2466C26.6023 21.7777 26.6023 23.0432 25.9578 23.9304C25.7496 24.2169 25.4976 24.4688 25.2111 24.677C24.3239 25.3216 23.0584 25.3216 20.5273 25.3216H7.47734C4.94627 25.3216 3.68074 25.3216 2.79357 24.677C2.50705 24.4688 2.25508 24.2169 2.04691 23.9304C1.40234 23.0432 1.40234 21.7777 1.40234 19.2466V9.66489Z"
        fill="#F7AD31"
      />
      <path d="M5.35156 12.8799H22.6483" stroke="white" strokeWidth="2.6775" />
    </svg>
  )
}

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the folder sheet followed by the tab's title text.
 */
export function FilesTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <FolderGlyph />
      {tab.title}
    </>
  )
}
