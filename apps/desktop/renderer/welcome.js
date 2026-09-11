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

document.querySelector('#api-key').addEventListener('click', () => {
  document.querySelector('#tagline').hidden = true
  document.querySelector('#entry-actions').hidden = true
  form.hidden = false
  document.querySelector('#key-actions').hidden = false
  welcome.setAttribute('aria-labelledby', 'key-title')
  welcome.classList.add('key-page')
  input.focus()
})

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
