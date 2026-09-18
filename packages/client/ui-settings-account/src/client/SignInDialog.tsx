/** Account authorization dialog shared by onboarding and explicit login. */
import { useEffect, useState } from 'react'
import { Button, IconCloseOutlineRegular, IconLoadingOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountKey } from './locales.ts'
import css from './SignInDialog.module.css'

/** @param props - safe account state, localized copy, and user actions. @returns login dialog. */
export function SignInDialog({ account, start, cancel, close, useApiKey, t }: {
  account: AccountSnapshot
  start: () => Promise<void>
  cancel: (id: SignInAttemptId) => Promise<void>
  close: () => void
  useApiKey: () => void
  t: (key: AccountKey) => string
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copyCount, setCopyCount] = useState(0)
  const attempt = account.view?.attempt
  useEffect(() => { setCopyCount(0) }, [attempt?.id, attempt?.authorizeUrl])
  useEffect(() => {
    if (copyCount === 0) return
    const timer = setTimeout(() => { setCopyCount(0) }, 2000)
    return () => { clearTimeout(timer) }
  }, [copyCount])
  const phase = attempt?.phase
  const active = busy || phase === 'initializing' || phase === 'waiting-browser' || phase === 'exchanging' || phase === 'committing'
  const expired = phase === 'expired'
  const error = failed || account.loginFailed || account.failed || phase === 'failed'
  const committing = phase === 'committing'
  useEffect(() => { if (account.view?.status === 'credential-stored') close() }, [account.view?.status, close])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setFailed(false)
    try { await action() } catch { setFailed(true) } finally { setBusy(false) }
  }
  const dismiss = () => {
    if (committing || busy) return
    if (active && attempt) void run(async () => { await cancel(attempt.id); close() })
    else close()
  }
  const title = active ? t('browserTitle') : expired ? t('timeoutTitle') : error ? t('failureTitle') : t('loginTitle')
  return <Modal open headless title={title} onClose={dismiss} className={css.dialog as string}>
    <div className={css.content}>
      <div className={css.header}>
        <h2 className={css.title}>{title}</h2>
        <button type="button" className={css.close} aria-label={t('close')} onClick={dismiss}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>
      {active ? <p className={css.description}>
        {t('browserPrompt')}<button type="button" className={css.link} disabled={!attempt?.authorizeUrl}
          onClick={() => {
            if (attempt?.authorizeUrl) void navigator.clipboard.writeText(attempt.authorizeUrl)
              .then(() => { setCopyCount(count => count + 1) }, () => { setFailed(true) })
          }}>
          {t(copyCount > 0 ? 'copiedLink' : 'copyLink')}
        </button>{t('browserDescription')}
      </p> : <p className={css.description}>
        {expired ? t('timeoutDescription') : error ? t('failed') : t('loginDescription')}
      </p>}
    </div>
    <div className={css.actions}>
      <Button variant="outline" className={css.secondaryButton} disabled={committing || busy}
        onClick={active ? dismiss : useApiKey}>{t(active ? 'cancel' : 'addApiKey')}</Button>
      <Button variant="primary" className={css.primaryButton} disabled={active || account.view === undefined}
        aria-label={active ? t('waiting') : undefined} onClick={() => { void run(start) }}>
        {active ? <IconLoadingOutlineRegular className={css.spinner} /> : t(expired || error ? 'retry' : 'signIn')}
      </Button>
    </div>
  </Modal>
}
