/**
 * Encode bytes as canonical browser base64 without overflowing argument limits.
 * @param data - bytes to encode.
 * @returns base64 text.
 */
export function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < data.length; offset += chunk) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}
