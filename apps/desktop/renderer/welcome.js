/* Desktop entry and API-key form; credentials leave only through the narrow preload. */
const api = window.dshWelcome
const { id, messages } = api
document.documentElement.lang = id
document.title = messages.welcomeTitle
document.querySelector('.brand').alt = messages.welcomeBrand
document.querySelector('#tagline-before').textContent = messages.welcomeTaglineBefore
document.querySelector('#tagline-brand').textContent = messages.welcomeTaglineBrand
document.querySelector('#tagline-after').textContent = messages.welcomeTaglineAfter
document.querySelector('#sign-in').textContent = messages.welcomeSignIn
document.querySelector('#api-key').textContent = messages.welcomeApiKey
document.querySelector('#key-title').textContent = messages.welcomeKeyTitle
document.querySelector('#key-description').textContent = messages.welcomeKeyDescription
document.querySelector('#key-label').textContent = messages.welcomeKeyPlaceholder
document.querySelector('#skip-key').textContent = messages.welcomeKeyLater
document.querySelector('#back-to-login').textContent = messages.welcomeKeyBack

const form = document.querySelector('#key-form')
const input = document.querySelector('#key-input')
const error = document.querySelector('#key-error')
const save = document.querySelector('#save-key')
const skip = document.querySelector('#skip-key')
const back = document.querySelector('#back-to-login')
const welcome = document.querySelector('.welcome')
let busy = false

input.placeholder = messages.welcomeKeyPlaceholder
save.textContent = messages.welcomeKeySave

function showError(message) {
  error.textContent = message
  error.hidden = message === ''
  input.setAttribute('aria-invalid', String(message !== ''))
}

function renderBusy() {
  input.disabled = busy
  save.disabled = busy || input.value.trim() === ''
  skip.disabled = busy
  back.disabled = busy
  form.setAttribute('aria-busy', String(busy))
}

function openApiKey() {
  authPageVisible = false
  document.querySelector('#auth-page').hidden = true
  document.querySelector('#auth-actions').hidden = true
  document.querySelector('#tagline').hidden = true
  document.querySelector('#entry-actions').hidden = true
  form.hidden = false
  document.querySelector('#key-actions').hidden = false
  welcome.setAttribute('aria-labelledby', 'key-title')
  welcome.classList.remove('expired-page')
  welcome.classList.add('key-page')
  input.focus()
}
document.querySelector('#api-key').addEventListener('click', openApiKey)
document.querySelector('#auth-api-key').addEventListener('click', openApiKey)

back.addEventListener('click', () => {
  if (busy) return
  input.value = ''
  showError('')
  renderBusy()
  form.hidden = true
  document.querySelector('#key-actions').hidden = true
  document.querySelector('#tagline').hidden = false
  document.querySelector('#entry-actions').hidden = false
  welcome.setAttribute('aria-labelledby', 'tagline')
  welcome.classList.remove('key-page')
  document.querySelector('#api-key').focus()
})

input.addEventListener('input', () => {
  showError('')
  renderBusy()
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (busy) return
  const value = input.value.trim()
  if (!/^[\x21-\x7e]+$/.test(value) || /^[A-Z][A-Z0-9_]*=[^=]/.test(value)
    || ((value.startsWith('"') || value.startsWith("'") || value.charCodeAt(0) === 96) && value.at(-1) === value[0])) {
    showError(value === '' ? messages.welcomeKeyBlank : messages.welcomeKeyInvalid)
    input.focus()
    return
  }
  busy = true
  showError('')
  renderBusy()
  try {
    const result = await api.saveApiKey(value)
    if (!result.ok) showError(messages.welcomeKeyFailed)
    else input.value = ''
  } catch {
    showError(messages.welcomeKeyFailed)
  } finally {
    busy = false
    renderBusy()
  }
})

skip.addEventListener('click', async () => {
  if (busy) return
  busy = true
  renderBusy()
  try {
    await api.skip()
    input.value = ''
  } catch {
    showError(messages.welcomeContinueFailed)
  } finally {
    busy = false
    renderBusy()
  }
})

renderBusy()


let authAttempt
let authPageVisible = false
const authPage = document.querySelector('#auth-page')
const authActions = document.querySelector('#auth-actions')
const authStatus = document.querySelector('#auth-status')
const authReopen = document.querySelector('#auth-reopen')
const authRetry = document.querySelector('#auth-retry')
const authCancel = document.querySelector('#auth-cancel')
authReopen.textContent = messages.welcomeAuthReopen
authRetry.textContent = messages.welcomeAuthRetry
document.querySelector('#auth-api-key').textContent = messages.welcomeApiKey
authCancel.textContent = messages.welcomeAuthCancel

function showAccount(state) {
  const attempt = state.attempt
  if (!authPageVisible && !form.hidden) return
  if (attempt === null && !authPageVisible) return
  authAttempt = attempt
  if (attempt?.phase === 'cancelled') {
    welcome.setAttribute('aria-labelledby', 'tagline')
    authPageVisible = false
    authPage.hidden = true
    authActions.hidden = true
    document.querySelector('#tagline').hidden = false
    document.querySelector('#entry-actions').hidden = false
    return
  }
  authPageVisible = true
  welcome.setAttribute('aria-labelledby', 'auth-status')
  authPage.hidden = false
  authActions.hidden = false
  document.querySelector('#tagline').hidden = true
  document.querySelector('#entry-actions').hidden = true
  const phase = attempt?.phase ?? 'failed'
  const failed = ['expired', 'failed'].includes(phase)
  authStatus.textContent = phase === 'initializing' ? messages.welcomeAuthStarting
    : phase === 'waiting-browser' ? messages.welcomeAuthWaiting
      : phase === 'expired' ? messages.welcomeAuthExpired
        : phase === 'failed' ? messages.welcomeAuthFailed : messages.welcomeAuthExchanging
  document.querySelector('#auth-description').hidden = phase !== 'expired'
  document.querySelector('#auth-description').textContent = messages.welcomeAuthExpiredDescription
  authPage.classList.toggle('auth-expired', phase === 'expired')
  welcome.classList.toggle('expired-page', phase === 'expired')
  document.querySelector('#auth-api-key').hidden = !failed
  authCancel.hidden = failed
  authReopen.hidden = failed
  authReopen.disabled = phase !== 'waiting-browser'
  authRetry.hidden = !failed
  authCancel.disabled = phase === 'committing' || phase === 'succeeded' || (phase === 'initializing' && !attempt?.id)
}

async function startSignIn() {
  authPageVisible = true
  showAccount({ attempt: { phase: 'initializing' } })
  try { showAccount(await api.startSignIn()) }
  catch { showAccount({ attempt: null }) }
}
document.querySelector('#sign-in').addEventListener('click', startSignIn)
authRetry.addEventListener('click', startSignIn)
authCancel.addEventListener('click', async () => {
  authCancel.disabled = true
  try {
    if (authAttempt?.id) showAccount(await api.cancelSignIn(authAttempt.id))
    else showAccount({ attempt: { phase: 'cancelled' } })
  } catch { authCancel.disabled = false }
})
authReopen.addEventListener('click', async () => {
  if (!authAttempt?.id) return
  try { await api.reopenSignIn(authAttempt.id) }
  catch { authStatus.textContent = messages.welcomeAuthFailed }
})
const stopAccount = api.onAccountState(showAccount)
window.addEventListener('pagehide', stopAccount, { once: true })
