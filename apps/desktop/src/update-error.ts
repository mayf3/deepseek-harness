/** Localized update preparation failures with separately displayed diagnostics. */

/** Only explicitly safe main-process facts may be exposed as technical details. */
export class DesktopUpdatePreparationError extends Error {
  /**
   * @param message - Locale-owned recovery guidance.
   * @param technicalDetails - Main-owned facts, excluding raw subprocess output and credentials.
   */
  constructor(message: string, readonly technicalDetails: string) { super(message) }
}
