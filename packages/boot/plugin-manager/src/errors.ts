/**
 * The failure a plugin operation raises: a code from the `plugins/*`
 * vocabulary and details typed by that code, with no Remote protocol
 * attached. The Web host's adapter turns one into a `RemoteError` of the same
 * code; the `dsh plugin` command prints it.
 * @module @deepseek-ai/dsh-plugin-manager/errors
 */

import type { PluginOperationCode, PluginOperationDetailsMap } from './types.ts'

/**
 * One refused or failed plugin operation. Discriminate by `code`: the
 * {@link PluginOperationFailure} union narrows `details` per code.
 */
export class PluginOperationError<Code extends PluginOperationCode = PluginOperationCode> extends Error {
  /** The stable failure code declared in {@link PluginOperationDetailsMap}. */
  readonly code: Code

  /** The structured payload the code declares. */
  readonly details: PluginOperationDetailsMap[Code]

  /**
   * @param code - the stable failure code.
   * @param message - human diagnostic.
   * @param details - structured payload typed by the code.
   * @param options - standard Error options; `cause` keeps the underlying failure.
   */
  constructor(code: Code, message: string, details: PluginOperationDetailsMap[Code], options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginOperationError'
    this.code = code
    this.details = details
  }
}

/** A plugin operation failure as the code-discriminated union, so a `code` branch narrows `details`. */
export type PluginOperationFailure = {
  [Code in PluginOperationCode]: PluginOperationError<Code>
}[PluginOperationCode]

/**
 * Narrow a caught value to a plugin operation failure.
 * @param value - a caught value.
 * @returns the failure when `value` is one, otherwise undefined.
 */
export function pluginOperationFailureOf(value: unknown): PluginOperationFailure | undefined {
  return value instanceof PluginOperationError ? value as PluginOperationFailure : undefined
}
