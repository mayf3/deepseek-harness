/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-llm-pi-ai/context
 */

import { CallId, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'

/** Join the text blocks of a harness message. */
function flattenText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}


/** Flatten text recursively inside one tool result. */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? toolResultText(block.content) : '').join('')
}

/** Model-facing stand-in for an image dropped to fit the request bound. */
export const OFFLOADED_IMAGE_TEXT
  = '[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/** Base64 length of `bytes` raw bytes (4 output characters per 3 input bytes, padded). */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Select the images a request must drop to fit the per-request payload bound.
 * History order is oldest-first, so the most recent images are omitted last.
 * A single image larger than the bound is itself omitted. Locations use
 * message and nested block indexes so JSON replay cannot change the result by
 * splitting or preserving shared object identities.
 * @param messages - complete request history, oldest first.
 * @param maxRequestImageBytes - bound on total base64-encoded image payload; undefined leaves every image in place.
 * @returns the image locations the conversion replaces with {@link OFFLOADED_IMAGE_TEXT}.
 */
function offloadedImages(
  messages: readonly Message[],
  maxRequestImageBytes: number | undefined,
): ReadonlySet<string> {
  const offloaded = new Set<string>()
  if (maxRequestImageBytes === undefined) return offloaded
  const images: { location: string; base64Bytes: number }[] = []
  const collect = (messageIndex: number, blocks: readonly ContentBlock[], prefix: readonly number[] = []): void => {
    for (const [blockIndex, block] of blocks.entries()) {
      const path = [...prefix, blockIndex]
      if (block.type === 'image') {
        images.push({
          location: `${messageIndex}:${path.join('.')}`,
          base64Bytes: base64Length(block.attachment.bytes),
        })
      } else if (block.type === 'tool-result') {
        collect(messageIndex, block.content, path)
      }
    }
  }
  for (const [messageIndex, message] of messages.entries()) collect(messageIndex, message.content)
  let total = images.reduce((sum, image) => sum + image.base64Bytes, 0)
  for (const image of images) {
    if (total <= maxRequestImageBytes) break
    offloaded.add(image.location)
    total -= image.base64Bytes
  }
  return offloaded
}

interface LocatedContentBlock {
  readonly block: ContentBlock
  readonly path: readonly number[]
}

/** Attach stable nested indexes to blocks from one message. */
function locatedBlocks(blocks: readonly ContentBlock[], prefix: readonly number[] = []): LocatedContentBlock[] {
  return blocks.map((block, index) => ({ block, path: [...prefix, index] }))
}

async function userContent(
  blocks: readonly LocatedContentBlock[],
  attachments: AttachmentStore,
  offloaded: ReadonlySet<string>,
  messageIndex: number,
): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const { block, path } of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        if (offloaded.has(`${messageIndex}:${path.join('.')}`)) {
          content.push({ type: 'text', text: OFFLOADED_IMAGE_TEXT })
          break
        }
        const stored = await attachments.readImage(block.attachment)
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
        break
      }
      case 'tool-result':
        {
          const nested = await userContent(locatedBlocks(block.content, path), attachments, offloaded, messageIndex)
          if (typeof nested === 'string') {
            if (nested.length > 0) content.push({ type: 'text', text: nested })
          } else {
            content.push(...nested)
          }
        }
        break
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).join('')
  return content
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...options.system !== undefined ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function textOnlyContext(options: GenerateOptions, onReplayDegrade?: (reason: string) => void): PiContext {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, onReplayDegrade)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      messages.push(assistant)
      continue
    }
    const text = flattenText(message)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) messages.push({ role: 'user', content: text, timestamp: 0 })
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{
          type: 'text',
          text: toolResultText(result.content) || '(no output)',
        }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return piContext(options, messages)
}

/**
 * Convert text-only harness history to a synchronous pi-ai Context. Tool
 * result names are recovered from preceding assistant tool calls.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param attachments - absent; selects the synchronous conversion.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @returns the pi-ai context; `tools` is omitted when the request declares none.
 */
export function toPiContext(
  options: GenerateOptions,
  attachments?: undefined,
  onReplayDegrade?: (reason: string) => void,
): PiContext
/**
 * Convert harness history to a pi-ai Context while resolving durable images.
 * Tool result names are recovered from preceding assistant tool calls. When
 * the accumulated base64 image payload exceeds `maxRequestImageBytes`, the
 * oldest images are replaced by text placeholders until the request fits, so
 * an image-heavy session keeps clearing gateway request-size caps.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param attachments - durable byte resolver for image references.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @param maxRequestImageBytes - request-level bound on base64-encoded image payload; omission leaves every image in place.
 * @returns the asynchronously resolved pi-ai context.
 */
export function toPiContext(
  options: GenerateOptions,
  attachments: AttachmentStore,
  onReplayDegrade?: (reason: string) => void,
  maxRequestImageBytes?: number,
): Promise<PiContext>
export function toPiContext(
  options: GenerateOptions,
  attachments?: AttachmentStore,
  onReplayDegrade?: (reason: string) => void,
  maxRequestImageBytes?: number,
): PiContext | Promise<PiContext> {
  return attachments === undefined
    ? textOnlyContext(options, onReplayDegrade)
    : toPiContextWithImages(options, attachments, onReplayDegrade, maxRequestImageBytes)
}

async function toPiContextWithImages(
  options: GenerateOptions,
  attachments: AttachmentStore,
  onReplayDegrade?: (reason: string) => void,
  maxRequestImageBytes?: number,
): Promise<PiContext> {
  const offloaded = offloadedImages(options.messages, maxRequestImageBytes)
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []

  for (const [messageIndex, message] of options.messages.entries()) {
    if (message.role === 'system') {
      if (contentHasImage(message.content)) {
        throw new LlmError('pi-ai cannot represent an image in an in-history system message', 'UNSUPPORTED_CONTENT')
      }
      // pi-ai has a single systemPrompt slot; in-history system messages are
      // folded into user messages to preserve order (rare in practice — the
      // harness sends the system prompt via options.system).
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, onReplayDegrade)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      }
      messages.push(assistant)
      continue
    }
    // user role: text + tool results (each result becomes its own message).
    const located = locatedBlocks(message.content)
    const regular = located.filter(({ block }) => block.type !== 'tool-result')
    const content = await userContent(regular, attachments, offloaded, messageIndex)
    const results = located.filter((entry): entry is LocatedContentBlock & { block: Extract<ContentBlock, { type: 'tool-result' }> } => (
      entry.block.type === 'tool-result'
    ))
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const { block: result, path } of results) {
      const resultContent = await userContent(locatedBlocks(result.content, path), attachments, offloaded, messageIndex)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string'
          ? [{ type: 'text', text: resultContent || '(no output)' }]
          : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }

  return piContext(options, messages)
}
