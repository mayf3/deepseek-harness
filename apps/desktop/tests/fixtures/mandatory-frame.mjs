import { setTimeout as delay } from 'node:timers/promises'

export async function mandatoryFrame(parent) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const frame = parent.webContents.mainFrame.frames.find(frame => frame.url === 'dsh-app://shell/mandatory-update.html')
    if (frame && await frame.executeJavaScript("document.readyState === 'complete'")) return frame
    await delay(20)
  }
  throw new Error('Mandatory update frame did not load')
}

export async function mandatoryFrameDriver(parent) {
  const frame = await mandatoryFrame(parent)
  const contents = new Proxy(parent.webContents, { get(target, key) {
    if (key === 'executeJavaScript') return frame.executeJavaScript.bind(frame)
    if (key === 'sendInputEvent') return event => target.sendInputEvent(typeof event.y === 'number' ? { ...event, y: event.y + 40 } : event)
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return new Proxy(parent, { get(target, key) {
    if (key === 'webContents') return contents
    if (key === 'isDestroyed') return () => frame.detached
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
