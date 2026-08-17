/**
 * Browser render service. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
import { createRoot } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import { buildRenderApp } from './app.tsx'

/** Mount operation exposed to the framework-free boot kernel. */
export interface AppShellService {
  /**
   * Mount the assembled application into the supplied element.
   * @param container - Application mount point.
   * @returns Disposer that unmounts the React root.
   */
  mount: (container: HTMLElement) => () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Mount face provided after the render service activates. */
    appShell: AppShellService
  }
}

/** Services required before application assembly. */
export const inject = ['slots', 'sessions', 'layout']

/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  ctx.slots.install(createSlotRenderer())
  ctx.reflect.provide('appShell', {
    mount: (container: HTMLElement): (() => void) => {
      const root = createRoot(container)
      root.render(buildRenderApp({ ctx })())
      return () => { root.unmount() }
    },
  })
}
