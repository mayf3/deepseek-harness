/**
 * The slots the Plugins page declares for plugins that carry their own
 * configuration: the official plugins listed beside the official bundles, one
 * bundle's configuration on its page, and one row's configuration opened from
 * that row. A registrant merges this contract with `import type` and registers
 * through `ctx.slots`; it never imports this package at runtime.
 *
 * Entries accept `page` for the form with its own save control and `summary`
 * for an official card's one-liner or a row's missing-description fallback.
 * Bundle configuration renders only `page`. The page draws the title, icon,
 * and crumb itself.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** The view the page asks a configuration entry for. */
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone, as text or inline nodes; `page` renders the form with its save control. */
  readonly view: 'summary' | 'page'
}

/** One user-requested bundle activation and navigation to its configuration page. */
export interface PluginActivationOwnerProps {
  readonly packageName: string
  /** Dismiss guidance for this activation. */
  readonly onDismiss: () => void
  /** Dismiss guidance and open this bundle's detail page. */
  readonly onOpenDetails: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Optional guidance after the user enables a bundle from the list, keyed by npm package name. */
    'plugins.bundle.activation': { kind: 'keyed'; scope: 'root'; owner: PluginActivationOwnerProps }
    /**
     * One official plugin the Plugins page lists in its Official group after
     * the official bundles: `label` is the card's title and `order` its place.
     * The page renders the entry as the card's one-liner (`view: 'summary'`)
     * and, once the card is opened, as the body of the plugin's own page
     * (`view: 'page'`). OCCUPIED by the host-plane configuration pages
     * `ui-settings-plugins` ships; a bundle's configuration belongs in
     * `plugins.bundle.config` or `plugins.row.config` instead.
     */
    'plugins.item': { kind: 'list'; scope: 'root'; owner: PluginConfigViewProps }
    /**
     * A bundle's own configuration, keyed by the bundle's package name and
     * rendered on the bundle's page between its description and its rows
     * (`view: 'page'` only).
     */
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
    /**
     * The configuration of one row a bundle declares, keyed by
     * `<package name>#<row id>` with the row id as the bundle's patch declares
     * it: the row on the bundle's page gains a configure control that opens
     * the entry's page, headed by the plugin's display title and description.
     * An absent description falls back to the entry's `view: 'summary'`.
     */
    'plugins.row.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
  }
}
