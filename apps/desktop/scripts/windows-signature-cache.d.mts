import type { WindowsRuntimeSignature } from './windows-runtime-signature.mjs'
import type { createWindowsTokenSigner } from './windows-sign.mjs'

/** File-owned cache policy and existing supervised signing operations. */
export interface WindowsSignatureCacheOptions {
  root: string
  identity: string
  thumbprint: string
  sign: ReturnType<typeof createWindowsTokenSigner>
  inspect: (path: string) => Promise<WindowsRuntimeSignature>
  record: (event: object) => void
}

/**
 * Hash the public certificate and files controlling signing output in fixed order.
 * @param files Certificate and signing-toolchain paths, excluding credentials.
 * @returns Content identity independent of installation paths and PIN values.
 */
export function signatureCacheIdentity(files: readonly string[]): Promise<string>

/**
 * Reuse complete signed files only after input, integrity, identity and timestamp checks.
 * @param options Cache policy, supervised signer, public-key verifier and audit sink.
 * @returns Serial signer that stops its queue on any failure and never repairs invalid cache entries.
 */
export function createCachedSigner(options: WindowsSignatureCacheOptions): ReturnType<typeof createWindowsTokenSigner>
