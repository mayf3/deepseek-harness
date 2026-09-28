/** Display text published directly by an already-loaded plugin. */
import type { Plugin } from '@deepseek-ai/cordis'
import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'

/** Optional `meta` export, or static class property, for ordinary plugin display text. */
export type LoadedPluginMeta = Pick<PluginLocalizedMeta, 'title' | 'description'>

/**
 * Project a loaded plugin's display text without resolving package resources.
 * @param plugin - Loader-unwrapped plugin, absent when the entry has no live plugin.
 * @returns Explicit title and description only, when the plugin publishes metadata.
 */
export function readLoadedPluginMeta(plugin: Plugin | undefined): LoadedPluginMeta | undefined {
  const meta = (plugin as (Plugin & { meta?: LoadedPluginMeta }) | undefined)?.meta
  if (meta === undefined) return undefined
  return {
    ...meta.title === undefined ? {} : { title: meta.title },
    ...meta.description === undefined ? {} : { description: meta.description },
  }
}
