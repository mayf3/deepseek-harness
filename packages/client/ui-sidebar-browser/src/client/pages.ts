/** Assemble navigation providers and presentation adapters without platform branches in consumers. */
import type { DesktopBrowserBridge } from '../desktop.ts'
import type { BrowserPage, BrowserPageOptions } from './browser/BrowserPage.ts'
import { IframeImpl } from './browser/IframeImpl.ts'
import { ElectronWebViewImpl } from './browser/ElectronWebViewImpl.ts'
import { IframePresentation } from './view/IframePresentation.ts'
import { ElectronWebviewPresentation } from './view/ElectronWebviewPresentation.ts'

/** @param options - saved navigation and callbacks. @returns the Web page's two independent faces. */
export function createIframePage(options: BrowserPageOptions): BrowserPage {
  const presentation = new IframePresentation({
    loaded: revision => { frame.handleLoaded(revision) },
    failed: revision => { frame.handleLoadFailed(revision) },
    remounted: () => { frame.reload() },
  })
  const frame = new IframeImpl(options, presentation)
  return { frame, presentation }
}

/**
 * @param options - checkpoint and source-tab callbacks.
 * @param bridge - desktop-only transport.
 * @param workspace - storage account resolver.
 * @returns separate navigation and presentation faces.
 */
export function createElectronPage(options: BrowserPageOptions, bridge: DesktopBrowserBridge,
  workspace: (signal: AbortSignal) => Promise<string>): BrowserPage {
  let frame: ElectronWebViewImpl
  const presentation = new ElectronWebviewPresentation({
    mounted: () => { frame.attach() },
    unmounted: () => { frame.detach() },
  })
  frame = new ElectronWebViewImpl(options, bridge, workspace, presentation)
  return { frame, presentation }
}
