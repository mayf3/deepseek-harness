import { describe, expect, it } from 'vitest'
import type { DeepSeekLlmApiJson } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  packSessionEvents,
  unpackJsonValue,
  unpackSessionEvents,
} from '../src/codec.ts'
import type { PackedJsonValue } from '../src/types.ts'

function event(data: unknown, seq = 0): SessionEvent {
  return {
    type: 'plugin/test',
    seq,
    time: 1_700_000_000_000 + seq,
    data,
  } as unknown as SessionEvent
}

describe('DeepSeek session-log codec', () => {
  it('replaces a raw assistant chunk with an exact slice of its assembled wire message', () => {
    const delta = 'streamed assistant content '.repeat(30)
    const source = {
      type: 'assistant/chunk',
      seq: 0,
      time: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: delta } },
    } as SessionEvent<'assistant/chunk'>
    const messages: DeepSeekLlmApiJson[] = [{ role: 'assistant', content: `prefix:${delta}:suffix` }]
    const packed = packSessionEvents([source], messages)

    expect(packed[0]?.encoding).toBe('message-references')
    expect(unpackSessionEvents(packed, messages)).toEqual([source])
  })

  it('references exact whole strings and reconstructs Unicode event values', () => {
    const text = `前缀-${'shared text '.repeat(40)}-结尾`
    const messages: DeepSeekLlmApiJson[] = [{ role: 'assistant', content: text }]
    const source = event({ nested: [{ text }], untouched: 3 })
    const packed = packSessionEvents([source], messages)

    expect(packed[0]?.encoding).toBe('message-references')
    expect(JSON.stringify(packed)).toContain('message-slice')
    expect(unpackSessionEvents(packed, messages)).toEqual([source])
  })

  it('keeps surrogate-splitting and ill-formed UTF-16 strings raw', () => {
    const high = String.fromCharCode(0xD83D)
    const low = String.fromCharCode(0xDE00)
    const tail = 'shared-tail-'.repeat(80)
    const cases = [
      { message: `😀${tail}`, logged: `${low}${tail}` },
      { message: `${tail}😀`, logged: `${tail}${high}` },
      { message: `${high}${tail}`, logged: `${high}${tail}` },
    ]

    for (const item of cases) {
      const source = event({ text: item.logged })
      const messages: DeepSeekLlmApiJson[] = [{ role: 'assistant', content: item.message }]
      const packed = packSessionEvents([source], messages)
      expect(packed).toEqual([{ encoding: 'raw', event: source }])
      expect(unpackSessionEvents(packed, messages)).toEqual([source])
    }
  })

  it('references one large inner message string and preserves literal prefix and suffix', () => {
    const shared = 'payload '.repeat(80)
    const messages: DeepSeekLlmApiJson[] = [{ role: 'tool', content: shared }]
    const source = event({ output: `before:${shared}:after` })
    const packed = packSessionEvents([source], messages)

    expect(packed[0]?.encoding).toBe('message-references')
    expect(unpackSessionEvents(packed, messages)).toEqual([source])
  })

  it('keeps short or unrelated events raw when references would expand them', () => {
    const messages: DeepSeekLlmApiJson[] = [{ role: 'user', content: 'tiny', empty: '', parts: [null, true, 5, 'nested'] }]
    const source = event({ text: 'tiny', empty: '', other: ['unrelated', true, null] })
    const packed = packSessionEvents([source], messages)
    expect(packed).toEqual([{ encoding: 'raw', event: source }])
    expect(unpackSessionEvents(packed, messages)).toEqual([source])
  })

  it('falls back to a raw event when referenced children do not reduce the complete envelope', () => {
    let found = false
    for (let length = 40; length <= 240; length += 1) {
      const text = 'x'.repeat(length)
      const source = event({ text })
      const packed = packSessionEvents([source], [{ content: text }])
      if (packed[0]?.encoding === 'raw' && length > 80) found = true
    }
    expect(found).toBe(true)
  })

  it('rejects missing paths, non-string targets, invalid ranges, and split UTF-8 code points', () => {
    const messages: DeepSeekLlmApiJson[] = [{ content: '😀abc', nested: [5] }]
    const packed = (value: object): PackedJsonValue => ({
      kind: 'string',
      parts: [{ kind: 'message-slice', value: value as never }],
    })
    expect(() => unpackJsonValue(packed({ messageIndex: 2, path: ['content'], utf8Start: 0, utf8End: 1 }), messages))
      .toThrow(/index 2 is absent/)
    expect(() => unpackJsonValue(packed({ messageIndex: 0, path: ['missing'], utf8Start: 0, utf8End: 1 }), messages))
      .toThrow(/invalid object segment/)
    expect(() => unpackJsonValue(packed({ messageIndex: 0, path: ['nested', 0], utf8Start: 0, utf8End: 1 }), messages))
      .toThrow(/does not resolve to a string/)
    expect(() => unpackJsonValue(packed({ messageIndex: 0, path: ['nested', 2], utf8Start: 0, utf8End: 1 }), messages))
      .toThrow(/invalid array segment/)
    expect(() => unpackJsonValue(packed({ messageIndex: 0, path: ['content'], utf8Start: -1, utf8End: 1 }), messages))
      .toThrow(/byte range is invalid/)
    expect(() => unpackJsonValue(packed({ messageIndex: 0, path: ['content'], utf8Start: 0, utf8End: 1 }), messages))
      .toThrow(/splits a UTF-8 code point/)
  })

  it('decodes every packed JSON variant and rejects unknown tags', () => {
    const messages: DeepSeekLlmApiJson[] = [{ content: 'abcdef' }]
    const value: PackedJsonValue = {
      kind: 'object',
      entries: [[
        'items',
        {
          kind: 'array',
          items: [
            { kind: 'literal', value: 1 },
            {
              kind: 'string',
              parts: [
                { kind: 'literal', value: 'x' },
                { kind: 'message-slice', value: { messageIndex: 0, path: ['content'], utf8Start: 1, utf8End: 4 } },
              ],
            },
          ],
        },
      ]],
    }
    expect(unpackJsonValue(value, messages)).toEqual({ items: [1, 'xbcd'] })
    expect(() => unpackJsonValue({ kind: 'future' } as never, messages)).toThrow(/unknown packed JSON value/)
  })
})
