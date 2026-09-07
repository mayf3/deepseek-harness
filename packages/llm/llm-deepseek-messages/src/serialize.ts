/** Convert Harness history into ordered Messages content without changing durable data. */

import { LlmError, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Connection } from './config.ts'
import { object, readReplay } from './replay.ts'
import type { WireBlock, WireInput, WireMessage, WireRequest } from './types.ts'

function unsupported(type: string): never {
  throw new LlmError(`DeepSeek Messages cannot represent ${type}`, 'UNSUPPORTED_CONTENT')
}

/** Parse tool input only when constructing an outgoing native tool_use block. */
function toolInput(raw: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(raw) } catch (_invalidToolHistoryJson) {
    throw new LlmError('DeepSeek Messages historical tool input is invalid JSON', 'INVALID_REQUEST')
  }
  return object(value, 'INVALID_REQUEST')
}

function assistant(message: Message, model: string, onReplayDegrade?: (reason: string) => void): WireBlock[] {
  const replay = readReplay(message, model, onReplayDegrade)
  return message.content.map((block, index): WireBlock => {
    switch (block.type) {
      case 'text': return { type: 'text', text: block.text }
      case 'reasoning': return {
        type: 'thinking', thinking: block.text,
        ...replay?.[index]?.signature === undefined ? {} : { signature: replay[index].signature },
      }
      case 'tool-call': return { type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) }
      default: return unsupported(`assistant content ${block.type}`)
    }
  })
}

/** Serialize one complete request using already prepared image bytes.
 * @param options - provider-neutral request.
 * @param connection - validated defaults and thinking policy.
 * @param history - image-projected history, still ordered by durable occurrence.
 * @param images - request versions for retained images.
 * @param access - execution-world paths for image descriptions.
 * @param onReplayDegrade - diagnostic for discarded native replay metadata.
 * @returns the Messages API JSON body.
 */
export function serialize(
  options: GenerateOptions, connection: Connection, history: readonly Message[],
  images: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>, access: ImageAttachmentAccessResolver,
  onReplayDegrade?: (reason: string) => void,
): WireRequest {
  const input = (blocks: readonly ContentBlock[]): WireInput[] => blocks.flatMap((block): WireInput[] => {
    if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : []
    if (block.type !== 'image') return unsupported(`user/tool-result content ${block.type}`)
    const version = images.get(block.attachment.attachmentId)
    if (version === undefined) throw new LlmError('DeepSeek Messages request image is missing', 'INVALID_REQUEST')
    return [
      { type: 'text', text: requestImageHandleText(block.attachment, version, access(block.attachment)) },
      { type: 'image', source: { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') } },
    ]
  })
  const messages: WireMessage[] = []
  const system = options.system === undefined ? [] : [options.system]
  for (const message of history) {
    if (message.role === 'system') {
      const texts = message.content.filter(block => block.type === 'text')
      if (messages.length > 0 || texts.length !== message.content.length) return unsupported('mid-conversation or non-text system message')
      system.push(texts.map(block => block.text).join(''))
      continue
    }
    const content: WireBlock[] = message.role === 'assistant' ? assistant(message, options.model, onReplayDegrade) : message.content.flatMap((block): WireBlock[] => {
      if (block.type !== 'tool-result') return input([block])
      return [{ type: 'tool_result', tool_use_id: block.toolCallId, content: input(block.content), ...block.isError === undefined ? {} : { is_error: block.isError } }]
    })
    const previous = messages.at(-1)
    if (previous?.role === message.role) previous.content.push(...content)
    else messages.push({ role: message.role, content })
  }
  let pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      const calls = message.content.filter(block => block.type === 'tool_use')
      pending = new Set(calls.map(block => block.id))
      if (pending.size !== calls.length) throw new LlmError('DeepSeek Messages duplicate tool call id', 'INVALID_REQUEST')
    } else {
      const results = message.content.filter(block => block.type === 'tool_result')
      for (const result of results) {
        if (!pending.delete(result.tool_use_id)) throw new LlmError('DeepSeek Messages tool result has no matching call', 'INVALID_REQUEST')
      }
      if (pending.size > 0) throw new LlmError('DeepSeek Messages tool calls need immediate results', 'INVALID_REQUEST')
      message.content = [...results, ...message.content.filter(block => block.type !== 'tool_result')]
    }
  }
  if (pending.size > 0) throw new LlmError('DeepSeek Messages history ends with unresolved tools', 'INVALID_REQUEST')
  const effort = options.purpose === 'session-title' ? 'off' : options.reasoningEffort ?? connection.reasoningEffort
  if (!['off', 'low', 'high', 'max'].includes(effort) || (connection.thinking === 'disabled' && effort !== 'off')) {
    throw new LlmError(`DeepSeek Messages does not support reasoning effort ${effort}`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  if (options.temperature !== undefined && effort !== 'off') {
    throw new LlmError('DeepSeek Messages temperature requires reasoningEffort off', 'UNSUPPORTED_OPTION')
  }
  const model = connection.models.find(entry => entry.id === options.model)
  return {
    model: options.model, stream: true, messages,
    max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
    ...effort === 'off' ? {} : { output_config: { effort: effort as 'low' | 'high' | 'max' } },
    ...system.length === 0 ? {} : { system: system.join('\n\n') },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
    ...options.tools === undefined ? {} : {
      tools: options.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
    },
  }
}
