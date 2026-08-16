import { Context } from '@deepseek-ai/cordis'
import { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Stateless schema operations used by settings-model component fixtures. */
export const settingsSchema = new SettingsSchemaService(new Context())
