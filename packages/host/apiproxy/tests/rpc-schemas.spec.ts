import { describe, expect, it } from 'vitest'
import { RpcId, transportError } from '../src/api/rpc.ts'
import {
  clientRequestSchema, rpcErrorSchema, rpcIdSchema, rpcMessageSchema,
  rpcResultSchema, serverResponseSchema,
} from '../src/api/rpc.schema.ts'
import { z } from 'zod'
import { hostDescribeRequestSchema, hostDescribeValueSchema } from '../src/api/host.schema.ts'

describe('RpcId', () => {
  it('brands a raw string at zero runtime cost', () => {
    expect(RpcId('abc')).toBe('abc')
    expect(rpcIdSchema.parse('abc')).toBe('abc')
    // No min-length: the id is an opaque echo token (see rpcIdSchema's contract).
    expect(rpcIdSchema.parse('')).toBe('')
    expect(() => rpcIdSchema.parse(42)).toThrow()
  })
})

describe('transportError', () => {
  it('folds Error and non-Error throws into the internal error branch', () => {
    expect(transportError(new Error('wire down'))).toEqual({ ok: false, error: { code: 'internal', message: 'wire down', details: {} } })
    expect(transportError('raw')).toMatchObject({ ok: false, error: { code: 'internal', message: 'raw' } })
  })
})

describe('rpcErrorSchema', () => {
  it('accepts every code branch with its required details', () => {
    expect(rpcErrorSchema.parse({ code: 'bad-request', message: 'm', details: { issues: [] } }).code).toBe('bad-request')
    expect(rpcErrorSchema.parse({ code: 'cancelled', message: 'm', details: {} }).code).toBe('cancelled')
    expect(rpcErrorSchema.parse({ code: 'session-not-found', message: 'm', details: { sessionId: 's' } }).code).toBe('session-not-found')
    expect(rpcErrorSchema.parse({ code: 'invalid-time-zone', message: 'm', details: { value: 'CST' } }).code).toBe('invalid-time-zone')
    expect(rpcErrorSchema.parse({ code: 'agent-preset-read-only', message: 'm', details: { agentPreset: 'p', reason: 'system' } }).code).toBe('agent-preset-read-only')
    expect(rpcErrorSchema.parse({ code: 'agent-preset-locked', message: 'm', details: { sessionId: 's', agentPreset: 'p' } }).code).toBe('agent-preset-locked')
    expect(rpcErrorSchema.parse({ code: 'agent-preset-not-found', message: 'm', details: { agentPreset: 'p', available: [] } }).code).toBe('agent-preset-not-found')
    expect(rpcErrorSchema.parse({ code: 'agent-preset-invalid', message: 'm', details: { agentPreset: 'p', reason: 'bad' } }).code).toBe('agent-preset-invalid')
    expect(rpcErrorSchema.parse({ code: 'agent-busy', message: 'm', details: { reason: 'r' } }).code).toBe('agent-busy')
    expect(rpcErrorSchema.parse({ code: 'internal', message: 'm', details: {} }).code).toBe('internal')
  })

  it('rejects a known code with missing details', () => {
    expect(() => rpcErrorSchema.parse({ code: 'agent-busy', message: 'm', details: {} })).toThrow()
    expect(() => rpcErrorSchema.parse({ code: 'internal', message: 'm' })).toThrow()
    expect(() => rpcErrorSchema.parse({ code: 'nope', message: 'm', details: {} })).toThrow()
  })
})

describe('rpcResultSchema', () => {
  it('accepts both result branches and rejects hybrids', () => {
    const schema = rpcResultSchema(z.object({ n: z.number() }))
    expect(schema.parse({ ok: true, value: { n: 1 } })).toEqual({ ok: true, value: { n: 1 } })
    const err = schema.parse({ ok: false, error: { code: 'internal', message: 'x', details: {} } })
    expect(err).toMatchObject({ ok: false })
    expect(() => schema.parse({ ok: true, error: {} })).toThrow()
  })
})

describe('wire full-form schemas', () => {
  it('parses both carrier forms and the union discriminates on type', () => {
    const cq = { type: 'client-request', rpcId: 'r1', method: 'host.describe', payload: {} }
    const sr = { type: 'server-response', rpcId: 'r1', result: { ok: true, value: 1 } }
    expect(clientRequestSchema.parse(cq).method).toBe('host.describe')
    expect(serverResponseSchema.parse(sr).rpcId).toBe('r1')
    for (const message of [cq, sr]) expect(rpcMessageSchema.parse(message)).toBeTruthy()
    expect(() => rpcMessageSchema.parse({ type: 'other', rpcId: 'x' })).toThrow()
  })

  it('rejects a quadrant missing its members but accepts a valueless success result', () => {
    expect(() => clientRequestSchema.parse({ type: 'client-request', rpcId: 'r1' })).toThrow()
    expect(() => serverResponseSchema.parse({ type: 'server-response', rpcId: 'r1' })).toThrow()
    expect(() => serverResponseSchema.parse({ type: 'server-response', rpcId: 'r1', result: {} })).toThrow()
    // A void business result carries no value field; the endpoint's own second
    // parse is what requires a value for methods that return data.
    expect(serverResponseSchema.parse({ type: 'server-response', rpcId: 'r1', result: { ok: true } }).rpcId)
      .toBe('r1')
  })
})

describe('host domain schemas', () => {
  it('validates describe request/value', () => {
    expect(hostDescribeRequestSchema.parse({})).toEqual({})
    const value = hostDescribeValueSchema.parse({
      version: '1', cwd: '/x', provider: 'p', model: 'm', attachedSessions: 2, home: '/h', canOpenPath: true,
    })
    expect(value).toMatchObject({ provider: 'p', model: 'm', attachedSessions: 2, canOpenPath: true })
    expect(hostDescribeValueSchema.parse({
      version: '1', cwd: '/x', attachedSessions: 0, home: '/h', canOpenPath: false,
    }).provider).toBeUndefined()
    expect(() => hostDescribeValueSchema.parse({
      version: '1', cwd: '/x', attachedSessions: 0,
    })).toThrow()
    expect(() => hostDescribeValueSchema.parse({
      version: '1', cwd: '/x', attachedSessions: 0, canOpenPath: true,
    })).toThrow()
  })
})
