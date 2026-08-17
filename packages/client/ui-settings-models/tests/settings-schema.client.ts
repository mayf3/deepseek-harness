import { Context } from '@deepseek-ai/cordis'
import { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSettingsSchemaOperations } from '../src/client/schema-operations.ts'

/** Stateless schema operations used by settings-model component fixtures. */
export const settingsSchema = createSettingsSchemaOperations(new SettingsSchemaService(new Context()))
