/** Shared shortcut badges; callers supply the effective platform presentation. */
import css from './ShortcutKeys.module.css'
import clsx from 'clsx'

/**
 * Render one command's keycaps without owning binding defaults or localized copy.
 * @param props - effective key labels and optional interaction styling.
 * @returns one rounded badge containing the key sequence.
 */
export function ShortcutKeys({ keys, className }: { keys: readonly string[]; className?: string | undefined }) {
  return <span className={clsx(css.keys, className)}>{keys.map((key, index) => <kbd key={index} className={css.key}>{key}</kbd>)}</span>
}
