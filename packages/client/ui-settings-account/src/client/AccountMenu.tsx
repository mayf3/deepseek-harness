/** Sidebar account launcher and locally authoritative sign-out action. */
import { useState } from 'react'
import { Menu, IconPaperPlaneOutline14, IconSettingsOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { SignInDialog } from './SignInDialog.tsx'
import { LogoutIcon } from './LogoutIcon.tsx'
import css from './AccountMenu.module.css'

/** Account launcher composed by the settings shell. */
export type AccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>

/** The signed-in label stays empty while the profile loads.
 * @param props - sidebar geometry, settings navigation and account operations.
 * @returns account menu launcher.
 */
export function AccountMenu({
  wide, openSettings, openOnboarding, useAccount, signOut, contactUs, showLogin, start, cancel, t,
}: AccountMenuProps) {
  const account = useAccount(state => state)
  const signedIn = account.view?.status === 'credential-stored'
  const profile = account.details?.profile
  const label = profile === undefined ? null : profile.status === 'ready' ? profile.value.name ?? t('signedIn') : t('signedIn')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const logout = async () => {
    setBusy(true)
    setFailed(false)
    try { await signOut(); setOpen(false) }
    catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return <div className={css.root}>
    <Menu open={open} side="top" portal autoFocus className={css.anchor} listClassName={css.menu}
      anchor={<button type="button" className={css.trigger} aria-label={t('menu')}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <span className={css.avatar}><IconUserOutline16 size={16} /></span>
        {wide && <span className={css.label}>{signedIn ? label : t('signedOut')}</span>}
      </button>}
      items={[
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutline16 size={16} /> },
        { id: 'contact', label: t('contactUs'), icon: <IconPaperPlaneOutline14 size={16} /> },
        ...(signedIn ? [{ id: 'signout', label: t('signOut'), icon: <LogoutIcon />, disabled: busy }]
          : [{ id: 'signin', label: t('signIn'), icon: <IconUserOutline16 size={16} /> }]),
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        if (id === 'settings') { setOpen(false); openSettings() }
        else if (id === 'contact') { setOpen(false); contactUs() }
        else if (id === 'signin') { setOpen(false); void start().catch(() => { setFailed(true) }) }
        else if (id === 'signout') void logout()
      }} />
    {account.loginVisible && !account.onboarding && <SignInDialog account={account} start={start} cancel={cancel} t={t}
      close={() => { showLogin(false) }} useApiKey={() => { showLogin(false); openOnboarding('deepseek-official') }} />}
    {failed && <span className={css.error} role="alert">{t('failed')}</span>}
  </div>
}
