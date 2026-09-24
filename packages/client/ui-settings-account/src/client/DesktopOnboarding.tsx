/** Coordinates onboarding navigation, transitions and the native recharge page. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { hasOnboardingCredit } from './onboarding-balance.ts'
import { OnboardingSurface } from './OnboardingSurface.tsx'
import type { DesktopOnboardingProps } from './onboarding-contract.ts'
import { PlatformOverlay } from './PlatformOverlay.tsx'
import { OnboardingWelcomeStep } from './OnboardingWelcomeStep.tsx'
import { OnboardingCreditStep } from './OnboardingCreditStep.tsx'
import { OnboardingPurposeStep } from './OnboardingPurposeStep.tsx'
import { OnboardingProcessStep } from './OnboardingProcessStep.tsx'
import { OnboardingConfirmation, type OnboardingConfirmationKind } from './OnboardingConfirmation.tsx'
import backIcon from './assets/onboarding-back.svg'
import css from './DesktopOnboarding.module.css'

/** @param props - durable choices, account state, localized copy and native recharge commands. @returns the active first-run page. */
export function DesktopOnboarding({
  state, account, platform, refresh, update, complete, retry, t, locale, exiting = false,
}: DesktopOnboardingProps) {
  const [dialog, setDialog] = useState<OnboardingConfirmationKind | null>(null)
  const [topUp, setTopUp] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const page = useRef<HTMLElement>(null)
  const progress = state.progress
  const targetStep = progress.step
  const [step, setStep] = useState(targetStep)
  const busy = state.status === 'loading' || state.status === 'saving' || exiting || step !== targetStep
  useEffect(() => {
    if (step === targetStep) return
    const element = page.current
    if (!state.visible || element?.animate === undefined || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStep(targetStep)
      return
    }
    const animation = element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 40, fill: 'forwards', easing: 'ease-out' })
    void animation.finished.then(() => { setStep(targetStep) }, (_error: unknown) => {
      // A newer step or unmount cancels this visual transition.
    })
    return () => { animation.cancel() }
  }, [targetStep, step, state.visible])
  useEffect(() => { heading.current?.focus() }, [step])
  if (state.visible && state.status === 'loading') return <OnboardingSurface>
    <div className={css.loading} role="status">{t('onboardingLoading')}</div>
  </OnboardingSurface>
  if (!state.visible || step === 'done') return null
  const go = (next: 'welcome' | 'credit' | 'purpose' | 'process') => { void update({ step: next }) }
  const recharge = () => { setDialog(null); setTopUp(true) }
  const returnFromRecharge = () => {
    setTopUp(false)
    void refresh().catch((_error: unknown) => {
      // The account view owns refresh errors; returning keeps the credit page available.
    })
  }
  const later = () => {
    const balance = account.details?.balance
    if (balance?.status === 'ready' && !hasOnboardingCredit(balance)) setDialog('credit')
    else go('purpose')
  }
  const purposeNext = () => {
    if (progress.purpose === 'office') void complete('completed')
    else go('process')
  }
  return <>
    <OnboardingSurface exiting={exiting}>
      <section key={step} ref={page} className={`${css.page} ${dialog !== null ? css.blurred : ''}`} data-desktop-onboarding={step} lang={locale} aria-labelledby="desktop-onboarding-title" aria-busy={busy}>
        {step === 'welcome' && <OnboardingWelcomeStep t={t} locale={locale} heading={heading} busy={busy} onStart={() => { go('credit') }} />}
        {step === 'credit' && <OnboardingCreditStep t={t} locale={locale} heading={heading} busy={busy}
          funded={state.creditFunded} canRecharge={platform !== undefined} onContinue={() => { go('purpose') }} onRecharge={recharge} onLater={later} />}
        {step === 'purpose' && <OnboardingPurposeStep t={t} heading={heading} busy={busy} purpose={progress.purpose}
          onSelect={(purpose) => { void update({ purpose }) }} onContinue={purposeNext} />}
        {step === 'process' && <OnboardingProcessStep t={t} heading={heading} busy={busy} process={progress.process}
          onSelect={(process) => { void update({ process }) }} onComplete={() => { void complete('completed') }} />}
        {state.error !== null && <div className={css.status} role="alert">{t('onboardingSaveFailed')}<Button disabled={busy} onClick={() => { void retry() }}>{t('onboardingRetry')}</Button></div>}
        {step !== 'welcome' && <footer className={css.navigation}>
          <button type="button" disabled={busy} onClick={() => { go(step === 'credit' ? 'welcome' : step === 'purpose' ? 'credit' : 'purpose') }}><span className={css.backIcon} style={{ maskImage: `url(${backIcon})` }} aria-hidden="true" />{t('onboardingBack')}</button>
          <button type="button" disabled={busy} onClick={() => { setDialog(step === 'credit' ? 'credit-skip' : 'skip') }}>{t('onboardingSkip')}</button>
        </footer>}
      </section>
    </OnboardingSurface>
    {dialog !== null && <OnboardingConfirmation kind={dialog} t={t} busy={busy} canRecharge={platform !== undefined}
      onClose={() => { setDialog(null) }} onContinue={() => { setDialog(null); go('purpose') }} onRecharge={recharge}
      onSkip={() => { void complete('skipped').then(() => { setDialog(null) }) }} />}
    {topUp && platform !== undefined && <PlatformOverlay bridge={platform} page="top-up"
      backLabel={t('backToHarness')} loadingLabel={t('loading')} failureLabel={t('failed')} retryLabel={t('platformRetry')} onClose={returnFromRecharge} />}
  </>
}
