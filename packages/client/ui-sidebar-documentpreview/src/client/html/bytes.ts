/** UTF-8 decoding for file bytes and encoding only for the iframe's script payload. */

/**
 * Decode complete UTF-8 text, rejecting invalid byte sequences.
 * @param data - complete UTF-8 bytes.
 * @returns decoded text; invalid UTF-8 throws.
 */
export function decodeText(data: Uint8Array<ArrayBuffer>): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(data)
}

/**
 * Encode Unicode text for the iframe's base64 payload.
 * @param text - Unicode text.
 * @returns base64 of its UTF-8 bytes.
 */
export function encodeText(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}
