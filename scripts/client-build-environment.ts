/** Prefix reserved for build-time values that may be embedded in browser artifacts. */
const CLIENT_BUILD_ENV_PREFIX = 'DSH_CLIENT_'

/**
 * Create bundler substitutions for public client build environment variables.
 *
 * The empty `process.env` fallback makes an unset static property read
 * evaluate to `undefined` without providing a browser `process` global.
 * Exact substitutions remain longer matches than that fallback. Dynamic
 * property reads and enumeration deliberately observe the empty object.
 *
 * @param environment - environment inherited by the build process.
 * @returns deterministic Vite/tsdown `define` expressions.
 */
export function clientBuildEnvironmentDefines(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const defines: Record<string, string> = { 'process.env': '{}' }
  for (const [name, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
    if (!name.startsWith(CLIENT_BUILD_ENV_PREFIX) || value === undefined) continue
    defines[`process.env.${name}`] = JSON.stringify(value)
  }
  return defines
}
