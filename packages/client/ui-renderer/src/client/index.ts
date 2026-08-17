/**
 * Browser UI renderer. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
import { createRoot } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from './scoped-slots.tsx'
import { buildRenderApp } from './app.tsx'

export { bindSnapshotSelector } from './bind.ts'

/** Selector hook over a session's conversation snapshot. */
export type UseSession<Snap extends object = object> = SnapshotSelectorHook<Snap>

export type {
  ChainRenderOpts, HostObservable, RenderOpts, SessionProvideInfo, SnapshotSelectorHook,
  SlotRenderer, SlotRendererHost, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'
export { SlotOwnershipError, StaleAuthorizationError } from '@deepseek-ai/dsh-client-ui-slots'
export { createSlotRenderer } from './scoped-slots.tsx'
export { SessionProvider, SlotAssemblyError, type SessionProviderProps } from './session-provider.tsx'

/** Mount operation exposed to the framework-free boot kernel. */
export interface UiRendererService {
  /**
   * Mount the assembled application into the supplied element.
   * @param container - Application mount point.
   * @returns Disposer that unmounts the React root.
   */
  mount: (container: HTMLElement) => () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Mount face provided after the UI renderer activates. */
    uiRenderer: UiRendererService
  }
}

/** Services required before application assembly. */
export const inject = ['slots', 'sessions']

/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  ctx.slots.install(createSlotRenderer())
  ctx.reflect.provide('uiRenderer', {
    mount: (container: HTMLElement): (() => void) => {
      const root = createRoot(container)
      root.render(buildRenderApp({ ctx })())
      return () => { root.unmount() }
    },
  })
}
