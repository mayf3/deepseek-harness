/**
 * The plugin card slots — one plugin's card, keyed by the settings namespace
 * the card edits. Options: `key` (the namespace). A card draws its own
 * internals; the surface only decides which namespaces to dispatch and stacks
 * what comes back. `settings.plugin.item` is the configuration tab, where a
 * card edits the global instance of its namespace; `settings.agentPreset.plugin.item`
 * is the settings section of a preset's detail page, where the same card
 * edits that preset's own scope. A card registers under both to appear on
 * both surfaces.
 *
 * Keying on the namespace is what lets a plugin distributed outside this
 * repository contribute a card: it registers its own settings namespace on the
 * Host and its own card under that key in the browser, and the surface pairs
 * the two without ever learning what the namespace means.
 *
 * TYPE HOME RATIONALE: this package declares both slots at runtime, and a
 * plugin registering its own card already depends on this package for the
 * declarations. The types therefore live with their declarer.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the plugin configuration tab (see module JSDoc). */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
    /** One plugin's card inside a preset's settings section (see module JSDoc). */
    'settings.agentPreset.plugin.item': { kind: 'keyed'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
  }
}

/** The two slots a plugin card registers under. */
export type CardSlot = 'settings.plugin.item' | 'settings.agentPreset.plugin.item'

/** Owner share of a plugin card (the surface supplies nothing). */
export interface SettingsPluginItemOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}
