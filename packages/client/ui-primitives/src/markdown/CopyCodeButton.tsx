/** Copy confirmation is local to the icon button, independent of source rendering. */
import { memo, useEffect, useRef, useState } from 'react'
import { writeClipboard } from '../clipboard.ts'
import { Tooltip } from '../Tooltip.tsx'
import { IconCheckOutline16, IconCopyOutline16 } from '../icons/index.tsx'
import css from './CodeBlock.module.css'

/**
 * Copy source without changing toolbar geometry.
 * @param props - Source and localized idle/success labels.
 * @returns A fixed-size icon action with local confirmation state.
 */
export const CopyCodeButton = memo(function CopyCodeButton({ code, copyLabel, copiedLabel }: {
  code: string
  copyLabel: string
  copiedLabel: string
}) {
  const [copied, setCopied] = useState(false)
  const alive = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [])
  const label = copied ? copiedLabel : copyLabel
  return <Tooltip label={label} side="top" delayMs={500}>
    <button type="button" className={css.iconButton} aria-label={label} onClick={() => {
      if (copied) return
      void writeClipboard(code).then((ok) => {
        if (!ok || !alive.current) return
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => { setCopied(false) }, 1000)
      })
    }}>
      <span aria-hidden="true">{copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}</span>
    </button>
  </Tooltip>
})
