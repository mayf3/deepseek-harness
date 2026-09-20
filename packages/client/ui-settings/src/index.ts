/** Host registration of shared Web and desktop developer-tool preferences. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { DEVELOPER_TOOLS_NAMESPACE, DeveloperToolsSettingsSchema } from './developer-tools-settings.ts'

/**
 * Register the developer-tool preference when user settings are available.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (scope) => {
    scope.settings.register(DEVELOPER_TOOLS_NAMESPACE, DeveloperToolsSettingsSchema)
  })
}
