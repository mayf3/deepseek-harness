/** Browser entry for the Web client. */
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
const entry = new AppWebEntry(el)
interface DesktopBootGlobal {
  dshDesktopBoot?: {
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; streamBaseUrl: string }>
  }
}
const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot
if (desktop !== undefined) {
  const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
  if (gate === undefined) throw new Error('desktop web: boot readiness is missing')
  void desktop.ready().then(async ({ injections, streamBaseUrl }) => {
    const transport = globalThis as { __DSH_TRANSPORT__?: { ownsHost: boolean; streamBaseUrl: string } }
    transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
    await applyIndexInjections(injections, src => new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = src
      script.onload = () => { resolve() }
      script.onerror = () => { reject(new Error(`desktop web: failed to load ${src}`)) }
      document.head.append(script)
    }))
    gate.resolve()
  }).catch((error: unknown) => { gate.reject(error) })
}
void entry.run()
