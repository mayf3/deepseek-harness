/** One accepted preference drives every developer-tool consumer. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { DeveloperToolsSettings } from '../developer-tools-settings.ts'
import type { SettingsScope } from './settings-contract.ts'

/** Shared preference; no accepted value means developer tools are disabled. */
export class DeveloperToolsPreference {
  /** Accepted enablement, observable through renderer-bound hooks. */
  readonly enabled: ObservableSnapshot<boolean>

  /** @param scope - settings-owned namespace controller. */
  constructor(private readonly scope: SettingsScope<DeveloperToolsSettings>) {
    this.enabled = {
      getSnapshot: () => scope.getSnapshot().value?.enabled ?? false,
      subscribe: listener => scope.subscribe(listener),
    }
  }

  /**
   * Persist a choice using the settings transport's ordered write and recovery policy.
   * @param enabled - requested developer-tool mode.
   * @returns settlement after the write or recovery read.
   */
  setEnabled(enabled: boolean): Promise<void> {
    return this.scope.set('enabled', enabled)
  }
}
