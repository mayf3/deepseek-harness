/** Per-control failure banner for path gestures. */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconWarningOutline16, Toast } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Transient failure banner owned by the control that initiated the gesture,
 * so one failed request announces once, from the control the user pressed.
 * @returns `toast` to render inside the control and `show` to announce one
 * failure with resolved copy; announcing again replays the banner.
 */
export function useOpenFailureToast(): { toast: ReactNode; show: (text: string) => void } {
  // The seq keys the banner so the same failure text replays instead of staying silently in place.
  const seq = useRef(0)
  const [banner, setBanner] = useState<{ seq: number; text: string } | null>(null)
  return {
    toast: banner === null
      ? null
      : <Toast key={banner.seq} text={banner.text} icon={<IconWarningOutline16 />} onDone={() => { setBanner(null) }} />,
    show: (text) => {
      seq.current += 1
      setBanner({ seq: seq.current, text })
    },
  }
}
