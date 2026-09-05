/**
 * The `settings.agentPreset.detail` slot type — the sections of one preset's
 * detail page under the Agent presets settings section, rendered in
 * registration order once a person opens a preset's configuration from its
 * card. The owner share names the preset; a registrant renders what it knows
 * about that preset (the plugin manager contributes the preset's capabilities).
 *
 * TYPE HOME RATIONALE: the section declares this slot at runtime, and a
 * plugin registering a detail section already depends on this package for the
 * declaration. The type therefore lives with its declarer.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One section of a preset's detail page (see module JSDoc). */
    'settings.agentPreset.detail': { kind: 'list'; scope: 'root'; owner: AgentPresetDetailOwnerProps }
  }
}

/** Owner share of a detail section: which preset the page shows. */
export interface AgentPresetDetailOwnerProps {
  /** The preset's id. */
  readonly presetId: string
  /** The preset's display name, resolved through the roster dictionaries. */
  readonly presetName: string
}
