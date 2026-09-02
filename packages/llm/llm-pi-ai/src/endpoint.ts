/**
 * Endpoint normalization shared by pi-ai model discovery and inference.
 *
 * @module dsh-llm-pi-ai/endpoint
 */

/**
 * Return the API root expected by the Anthropic SDK.
 *
 * Anthropic resource methods append `/v1/...` themselves. Accepting a user
 * address that already ends in `/v1` therefore requires removing that suffix
 * before model routing, while discovery appends its own native listing path to
 * the same root.
 * @param baseURL - configured Anthropic endpoint, with or without `/v1`.
 * @returns the endpoint root without trailing slashes or a terminal `/v1`.
 */
export function anthropicApiRoot(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return base.endsWith('/v1') ? base.slice(0, -3) : base
}
