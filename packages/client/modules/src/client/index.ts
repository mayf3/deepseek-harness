/**
 * Browser half (the standard `./client` export): the module-system class and
 * wire contract, plus the enrollment plugin face. The module system itself is
 * built by the shell kernel BEFORE cordis exists (the bootstrap exception —
 * the mechanism that loads plugins cannot arrive through itself). The host
 * parser-preloads this ordinary client bundle into the handoff queue; the
 * kernel claims and materializes that handoff, constructs the system, and
 * registers the same exports for this package's graph row. The plugin face
 * only enrolls that pre-existing instance by providing it as `ctx.modules`.
 * @module @deepseek-ai/dsh-client-modules/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DshWindow } from './manifest.ts'

export { ClientModuleSystem } from './system.ts'
export { parseBootManifest, stripClientSuffix } from './manifest.ts'
export type {
  BootManifest, BootModuleRow, BootPluginRow, ClientModuleLoader, ClientModuleRecord,
  ClientModuleHandoffQueue, ClientModuleHandoffSink, ClientModuleHandoffTarget,
  ClientModuleSystemOptions, ClientPluginHandoff, DshWindow,
  WebBootEntry, WebBootGraph,
} from './manifest.ts'

/**
 * Enroll the kernel-built module system as `ctx.modules`.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const modules = (globalThis as DshWindow).__DSH_MODULES__
  // The kernel writes the slot right after constructing the instance, before
  // any cordis entry exists — a missing slot means the kernel sequencing broke.
  if (modules === undefined) {
    throw new Error('client-modules: window.__DSH_MODULES__ missing — the shell kernel must construct the module system before plugin boot')
  }
  ctx.reflect.provide('modules', modules)
}
