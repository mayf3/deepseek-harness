/**
 * Leading-byte image-format identification for consumers that accept image
 * files without a media-type-bearing file name, such as normalized attachment
 * object paths. The result names the container the signature claims; callers
 * that persist bytes keep the attachment service's full decode authoritative.
 * @module @deepseek-ai/dsh-attachment/src/sniff
 */

import type { ImageMediaType } from './types.ts'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const

function matchesBytes(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (data.byteLength < offset + expected.length) return false
  return expected.every((byte, index) => data[offset + index] === byte)
}

function matchesAscii(data: Uint8Array, offset: number, text: string): boolean {
  if (data.byteLength < offset + text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (data[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

/**
 * Identify a supported image container from its file signature.
 * @param data - the leading file bytes; passing the complete file is fine.
 * @returns the media type the signature claims, or undefined when the bytes
 *   carry no complete PNG/JPEG/WebP/GIF signature.
 */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesBytes(data, 0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif'
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}
