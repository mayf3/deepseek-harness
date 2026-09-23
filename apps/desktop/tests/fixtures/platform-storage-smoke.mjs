/** Real Electron fixture for account-scoped Platform storage across process restarts. */
import { app, BrowserWindow } from 'electron'
import { pathToFileURL } from 'node:url'

const OBSERVE = `(() => {
  const button = document.querySelector('button')
  return button === null ? 'hidden' : 'visible'
})()`

const bounds = { x: 0, y: 0, width: 800, height: 600 }

/**
 * Read the notice state from the embedded document.
 * @param contents - embedded Platform page.
 * @returns `visible` while the dismissal control is rendered, otherwise `hidden`.
 */
async function observe(contents) {
  const value = await contents.executeJavaScript(OBSERVE, true)
  if (value !== 'visible' && value !== 'hidden') throw new Error(`unexpected notice state ${String(value)}`)
  return value
}

/**
 * @param owner - application window containing the embedded view.
 * @returns the current embedded Platform view.
 */
function platformView(owner) {
  const view = owner.contentView.children.find(child => typeof child.webContents?.executeJavaScript === 'function')
  if (view === undefined) throw new Error('embedded Platform view is missing')
  return view
}

/**
 * Click the notice's dismissal control and wait, bounded, until the notice leaves the DOM.
 * @param contents - embedded Platform page.
 */
async function dismissNotice(contents) {
  const clicked = await contents.executeJavaScript(
    `(() => { const button = document.querySelector('button'); if (button === null) return false; button.click(); return true })()`,
    true)
  if (clicked !== true) throw new Error('notice dismissal control is missing')
  if (await observe(contents) !== 'hidden') throw new Error('notice stayed visible after dismissal')
}

/**
 * Await the storage cleanup the previous `close` scheduled without leaving another document open: `open`
 * awaits that cleanup before it creates a view, and the immediate `close` invalidates it first.
 * @param manager - embedded Platform view owner.
 * @param owner - application window containing the embedded view.
 */
async function settleCleanup(manager, owner) {
  manager.close()
  const reopening = manager.open(owner, 'usage', bounds)
  manager.close()
  await reopening
}

async function run() {
  const [bundleFile, userData, origin, phase] = process.argv.slice(2)
  if (bundleFile === undefined || userData === undefined || origin === undefined || phase === undefined) {
    throw new Error('expected <bundled-platform-view.mjs> <userDataDir> <origin> <first|restart>')
  }
  if (phase !== 'first' && phase !== 'restart') throw new Error(`unknown phase ${phase}`)
  const base = new URL(origin).origin
  app.setPath('userData', userData)
  await app.whenReady()
  const { DesktopPlatformView } = await import(pathToFileURL(bundleFile).href)
  const owner = new BrowserWindow({ show: false, width: 900, height: 700 })
  const manager = new DesktopPlatformView('', () => 'en_US')
  const account = userId => ({ origin: base, token: 'fixture-secret', userId })
  const states = []
  const record = async name => {
    states.push(`${name}=${await observe(platformView(owner).webContents)}`)
  }

  manager.setSession(account('first'))
  await manager.open(owner, 'usage', bounds)
  await record(phase === 'first' ? 'first-open' : 'restart-first-open')
  if (phase === 'first') {
    await dismissNotice(platformView(owner).webContents)
    await record('first-got-it')
    await platformView(owner).webContents.executeJavaScript("document.cookie = 'fixture-auth=secret; SameSite=Lax'")
    manager.close()
    await manager.open(owner, 'usage', bounds)
    await record('first-reopen')
    const cookies = await platformView(owner).webContents.executeJavaScript('document.cookie')
    if (cookies !== '') throw new Error('authentication cookies survived close')
    states.push('reopen-cookies=cleared')
    manager.setSession(account('second'))
    await manager.open(owner, 'usage', bounds)
    await record('second-account')
    manager.setSession(account('first'))
    await manager.open(owner, 'usage', bounds)
    await record('back-to-first')
    manager.setSession(null)
    manager.setSession({ ...account('first'), token: 'new-grant' })
    await manager.open(owner, 'usage', bounds)
    await record('signed-in-again')
  }
  await settleCleanup(manager, owner)

  const lines = `${states.map(state => `state ${state}`).join('\n')}\nPLATFORM_STORAGE_RESULT ${JSON.stringify(states)}\n`
  await new Promise((resolve, reject) => process.stdout.write(lines, error => error ? reject(error) : resolve()))
  owner.destroy()
  app.quit()
}

run().catch(error => {
  console.error(`PLATFORM_STORAGE_ERROR ${error instanceof Error ? error.message : String(error)}`)
  app.exit(1)
})
