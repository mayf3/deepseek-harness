/** Account settings renders safe Host state and explicit login actions. */
import { Big } from 'big.js'
import { useEffect, useState, type MouseEvent } from 'react'
import { Button, IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountDetails, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PropsRuntime, PropsLocale, InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { PlatformOverlay, type PlatformBridge } from './PlatformOverlay.tsx'
import { formatBalance } from './formatBalance.ts'
import { AccountAvatar } from './AccountAvatar.tsx'
import { authorizeUrlWithTheme } from './authorize-url.ts'
import type { BonusNotice } from './bonus-notices.ts'
import css from './AccountSection.module.css'

/** Safe account snapshot shared by the settings page and launcher. */
export interface AccountSnapshot {
  /** Server-authored bonus notice awaiting display, absent when none is available. */
  notice?: BonusNotice

  /** Latest Host state, absent until the stream responds. */
  view: AccountView | undefined
  /** Sanitized profile and balance query outcomes, absent while loading. */
  details: Partial<AccountDetails> | undefined
  /** Whether the state stream failed. */
  failed: boolean
  /** Explicitly opened account dialog outside onboarding. */
  loginVisible?: boolean
  /** Latest explicit start request failed before a Host state was available. */
  loginFailed?: boolean
  /** Mounted onboarding owns the dialog while active. */
  onboarding?: boolean
}

/** Host operations injected into the Cordis-free account component. */
export interface AccountSectionInjected {
  /** Subscribe to live credential-expiry notifications.
   * @param listener - callback after the current credential is removed.
   * @returns listener cleanup.
   */
  subscribeSessionExpired?: (listener: () => void) => () => void
  /** Subscribe to live model sign-in guidance; the returned function removes the listener.
   * @param listener - callback for one rejected account-model request.
   * @returns listener cleanup.
   */
  subscribeModelSignInRequired?: (listener: () => void) => () => void
  /** Desktop-only commands; absent in ordinary browsers. */
  platform?: PlatformBridge

  /** Account stream owned by the Host and theme snapshots published by the renderer, observed through framework hooks. */
  hooks: {
    account: HostObservable<AccountSnapshot>
    /** Palette the Platform login pages follow. */
    theme: HostObservable<ThemeSnapshot>
  }
  /**
   * Read the balance, bonus wallets and unnotified bonus once. The Settings launcher
   * calls it on each entry and the top-up view calls it when the user returns.
   * @returns after both reads settle.
   */
  refreshAccount: () => Promise<void>
  /** Open the external support questionnaire with the current build and browser environment. */
  contactUs: () => void
  /** Open or dismiss the login dialog. */
  showLogin: (visible: boolean) => void
  /** Claim dialog ownership for the onboarding step. */
  setOnboarding: (active: boolean) => void
  /** @param orderId - notice whose card finished a presented frame while visible. */
  bonusNoticeShown: (orderId: BonusNotice['orderId']) => void
  /** @param orderId - notice the user closed. */
  bonusNoticeDismissed: (orderId: BonusNotice['orderId']) => void
  /** @returns after the login attempt is created. */
  start: () => Promise<void>
  /** @param id - attempt to cancel. @returns after cancellation or an already-admitted commit. */
  cancel: (id: SignInAttemptId) => Promise<void>
  /** @returns whether a running task currently uses the account token. */
  hasRunningAccountTasks: () => Promise<boolean>
  /** @returns after local account credentials are removed. */
  signOut: () => Promise<void>
}
/** Composed account section props. */
export type AccountSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>
/** @param props - localized actions and account subscription. @returns account settings UI. */
export function AccountSection({ t, useAccount, useTheme, start, cancel, platform, refreshAccount }: AccountSectionProps) {
  const { view: state, details, failed: streamFailed } = useAccount(value => value)
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  const [platformPage, setPlatformPage] = useState<'usage' | 'top-up'>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const profile = details?.profile?.status === 'ready' ? details.profile.value : undefined
  const wallets = details?.balance?.status === 'ready' ? details.balance.value : undefined
  const bonusWallets = details?.balance?.status === 'ready'
    ? details.balance.bonusWallets.filter(wallet => new Big(wallet.balance).gt(0)) : []
  const attempt = state?.attempt
  const active = attempt !== null && attempt !== undefined
    && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(attempt.phase)
  const signedIn = state?.status === 'credential-stored'
  useEffect(() => { if (!signedIn) setPlatformPage(undefined) }, [signedIn])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setFailed(false)
    try { await action() } catch { setFailed(true) } finally { setBusy(false) }
  }
  /**
   * @param event - click on a Platform destination link.
   * @returns nothing; on Desktop the embedded page replaces the pending navigation.
   */
  const openUsage = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (platform !== undefined && signedIn) { event.preventDefault(); setPlatformPage('usage') }
  }
  /**
   * The Platform entry the balance rows share with the Usage action: an embedded page on
   * Desktop, a new tab elsewhere. A wallet read that failed still reaches the same
   * destination, so the user can inspect the balance the Harness could not load; the
   * destination comes from the account links, not from the wallet response.
   * @param label - localized link copy.
   * @param className - link treatment for the row that renders it, absent when the sheet has no such rule.
   * @returns the Platform anchor.
   */
  const platformLink = (label: string, className: string | undefined) => (
    <a className={className} href={state?.links.usageUrl} aria-disabled={state === undefined}
      target="_blank" rel="noreferrer" onClick={openUsage}>{label}</a>
  )
  const status = failed || streamFailed || attempt?.phase === 'failed' ? t('failed')
    : attempt?.phase === 'expired' ? t('expired')
      : active ? t(attempt.phase === 'initializing' ? 'initializing' : attempt.phase === 'waiting-browser' ? 'waiting' : 'completing')
        : signedIn ? profile?.contact ?? t(details?.profile === undefined ? 'loading' : 'profileUnavailable') : t('signInDescription')
  if (!signedIn && !active) return (
    <section className={css.signedOut} aria-label={t('nav')}>
      <div className={css.signedOutContent}>
        <div className={css.signedOutCopy}>
          <span className={css.signedOutTitle}>{t('settingsSignedOutTitle')}</span>
          <span className={css.signedOutDescription} role="status">
            {failed || streamFailed ? t('failed') : t('settingsSignedOutDescription')}
          </span>
        </div>
        <Button variant="primary" className={css.signInButton} disabled={busy || state === undefined}
          onClick={() => { void run(start) }}>{t('signIn')}</Button>
      </div>
    </section>
  )
  return (
    <section className={css.section} aria-label={t('nav')}>
      {platformPage !== undefined && platform !== undefined && signedIn && <PlatformOverlay
        bridge={platform} page={platformPage} backLabel={t('backToHarness')}
        loadingLabel={t('loading')} failureLabel={t('platformFailed')} retryLabel={t('platformRetry')}
        onClose={() => {
          // Returning from top-up may have changed what the account holds, so the
          // page leaves immediately and the reads settle behind it. Usage changes
          // no account state, so leaving it stays as cheap as it was.
          const page = platformPage
          setPlatformPage(undefined)
          if (page === 'top-up') void refreshAccount()
        }} />}
      <div className={css.card}>
        <div className={css.identity}>
          <span className={css.avatar}><AccountAvatar url={signedIn ? profile?.avatarUrl : null} /></span>
          <div className={css.identityCopy}>
            <span className={css.name}>{signedIn ? profile?.name ?? t('signedIn') : t('signedOut')}</span>
            <span className={css.status} role="status">{status}</span>
          </div>
        </div>
        {signedIn && <a className={css.accountInfo} href={new URL('/', state.links.usageUrl).href} target="_blank" rel="noopener noreferrer">
          {t('accountInfo')}<IconRightUpOutlineRegular size={12} />
        </a>}
      </div>
      {active && <div className={css.actions}>
        {attempt.authorizeUrl && <a className={css.linkButton} href={authorizeUrlWithTheme(attempt.authorizeUrl, colorScheme)}
          target="_blank" rel="noreferrer">
          {t('open')}
        </a>}
        <Button variant="outline" className={css.button} disabled={busy || attempt.phase === 'committing'}
          onClick={() => { void run(() => cancel(attempt.id)) }}>{t('cancel')}</Button>
      </div>}
      <div className={css.balanceCard}>
        <div className={css.row}>
          <span>{t('balance')}</span>
          {signedIn && wallets !== undefined && wallets.length > 0
            ? <span className={css.amount}>{wallets.map(wallet => <span key={wallet.currency}>
              {formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')}
            </span>)}</span>
            : !signedIn || details?.balance === undefined
              ? <span className={css.unavailable}>{t(!signedIn ? 'balanceSignedOut' : 'loading')}</span>
              : platformLink(t('balanceUnavailable'), css.unavailableLink)}
        </div>
        {signedIn && <>
          <div className={css.divider} />
          <div className={css.row}>
            <span>{t('bonusBalance')}</span>
            <span className={css.bonusValue}>
              {bonusWallets.length > 0
                ? <span className={css.amount}>{bonusWallets.map(wallet => <span key={wallet.currency}>
                  {formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')}
                </span>)}</span>
                : details?.balance === undefined
                  ? <span className={css.unavailable}>{t('loading')}</span>
                  : details.balance.status === 'failed'
                    ? platformLink(t('balanceUnavailable'), css.unavailableLink)
                    : <span className={css.unavailable}>{t('bonusEmpty')}</span>}
            </span>
          </div>
        </>}
        <div className={css.divider} />
        <div className={css.row}>
          <span className={css.secondary}>{t('more')}</span>
          <div className={css.links}>
            {platformLink(t('usage'), css.linkButton)}
            <a className={`${css.linkButton} ${css.primary}`} href={state?.links.topUpUrl} aria-disabled={state === undefined}
              target="_blank" rel="noreferrer"
              onClick={(event) => { if (platform !== undefined && signedIn) { event.preventDefault(); setPlatformPage('top-up') } }}>{t('topUp')}</a>
          </div>
        </div>
      </div>
    </section>
  )
}
