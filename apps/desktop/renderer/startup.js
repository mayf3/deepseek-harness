const api = window.dshDesktop

async function main() {
  const { id, messages } = await api.locale()
  document.documentElement.lang = id
  document.querySelector('#page-title').textContent = messages.startupLoading
  document.querySelector('#retry').textContent = messages.retry
  document.querySelector('#plugins').textContent = messages.managePlugins
  function render(state) {
    const failed = state.phase === 'error'
    document.querySelector('main').setAttribute('aria-busy', String(!failed))
    document.querySelector('#spinner').hidden = failed
    document.querySelector('#title').textContent = failed ? messages.startupFailed : messages.startupLoading
    document.querySelector('#description').textContent = failed ? messages.startupErrorDescription : messages.startupLoadingDescription
    document.querySelector('#error').hidden = !failed
    document.querySelector('#error').textContent = failed ? state.message : ''
    document.querySelector('#actions').hidden = !failed
    document.querySelector('#retry').disabled = !failed
    document.querySelector('#plugins').disabled = !failed
  }
  let changed = false
  const unsubscribe = api.backend.subscribe(state => { changed = true; render(state) })
  window.addEventListener('pagehide', unsubscribe, { once: true })
  const initial = await api.backend.status()
  if (!changed) render(initial)
  document.querySelector('#retry').addEventListener('click', async () => {
    render({ phase: 'starting' })
    try { await api.backend.retry() }
    catch (error) { render({ phase: 'error', message: error instanceof Error ? error.message : String(error) }) }
  })
  document.querySelector('#plugins').addEventListener('click', async () => {
    try { await api.openPlugins() }
    catch (error) { render({ phase: 'error', message: error instanceof Error ? error.message : String(error) }) }
  })
}

void main()
