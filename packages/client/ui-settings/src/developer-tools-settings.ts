/** Shared Web and desktop developer-tool preference stored by the Host. */
import z from '@deepseek-ai/schemastery'

/** Namespace for developer UI and HTML preview capabilities. */
export const DEVELOPER_TOOLS_NAMESPACE = 'ui-developer-tools'

/** Persisted developer-tool choice. */
export interface DeveloperToolsSettings {
  /** Enable diagnostic views, preset selection, change summaries and scripted HTML previews. */
  enabled: boolean
}

/** New installations and missing values enable developer tools. */
export const DeveloperToolsSettingsSchema: z<DeveloperToolsSettings> = z.object({
  enabled: z.boolean().default(true),
})
