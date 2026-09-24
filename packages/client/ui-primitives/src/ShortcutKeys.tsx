/** Shared shortcut keycaps; callers supply the effective platform presentation. */
import css from './ShortcutKeys.module.css'
import clsx from 'clsx'

/**
 * Render one command's keycaps without owning binding defaults or localized copy.
 * @param props - effective key labels, presentation variant and optional interaction styling.
 * @returns keycaps (joined for plus-separated combinations), or unboxed keys for compact text hints.
 */
export function ShortcutKeys({ keys, variant = 'keycaps', className }: { keys: readonly string[]; variant?: 'keycaps' | 'plain' | 'tooltip'; className?: string | undefined }) {
  return <span className={clsx(css.keys, css[variant], variant !== 'plain' && keys.includes('+') && css.joined, className)}>{keys.map((key, index) => <kbd key={index} className={key === '+' ? css.separator : css.key}>{key}</kbd>)}</span>
}
