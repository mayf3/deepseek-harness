/** Startup variables required by native executables before model evaluation. */

/** Native executable search and Windows system paths retained in the OS environment. */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR'])
