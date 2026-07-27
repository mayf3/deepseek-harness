/**
 * Browser-safe human projection helpers for durable prompt messages.
 *
 * @module @deepseek-ai/dsh-session/display
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PromptMessageData } from './types.ts'

/**
 * Return the human-facing prompt blocks from a durable prompt message.
 * @param data - ordinary or steering prompt event data.
 * @returns the effective direct prompt, excluding baked prefix context.
 */
export function displayPromptContent(data: PromptMessageData): ContentBlock[] {
  return data.envelope?.displayContent ?? data.content
}
