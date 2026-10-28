import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session'

/** One exact native call admitted by a trusted process policy. */
export interface NativeToolAllowedCall {
  readonly toolName: string
  readonly argumentEquals?: Readonly<Record<string, JsonValue>>
}

/** Immutable opt-in allowlist received in the trusted process initialize request. */
export interface NativeToolPolicy {
  readonly version: 1
  readonly agentId: string
  readonly mode: 'native-allowlist'
  readonly allowedCalls: readonly NativeToolAllowedCall[]
  readonly policyDigest: string
}

/** Identity and digest echoed after the policy is validated and bound. */
export interface NativeToolPolicyAcknowledgement {
  readonly version: 1
  readonly agentId: string
  readonly policyDigest: string
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const record = value
  return `{${Object.keys(record).sort().map((key) => {
    const item = record[key]
    if (item === undefined) throw new TypeError('native tool policy contains an undefined value')
    return `${JSON.stringify(key)}:${canonicalJson(item)}`
  }).join(',')}}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key))
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function detachAndFreeze(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(detachAndFreeze)) as unknown as JsonValue
  const clone: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) clone[key] = detachAndFreeze(item)
  return Object.freeze(clone)
}

function canonicalDigest(policy: Omit<NativeToolPolicy, 'policyDigest'>): string {
  return createHash('sha256').update(canonicalJson(policy as unknown as JsonValue)).digest('hex')
}

function selectorsOverlap(left: NativeToolAllowedCall, right: NativeToolAllowedCall): boolean {
  if (left.argumentEquals === undefined || right.argumentEquals === undefined) return true
  for (const key of Object.keys(left.argumentEquals)) {
    const leftValue = left.argumentEquals[key]
    const rightValue = right.argumentEquals[key]
    if (Object.hasOwn(right.argumentEquals, key)
      && leftValue !== undefined && rightValue !== undefined
      && canonicalJson(leftValue) !== canonicalJson(rightValue)) return false
  }
  return true
}

/** Validate, verify and detach a policy received across the process boundary. */
export function validateNativeToolPolicy(input: unknown, knownToolNames: ReadonlySet<string>): NativeToolPolicy {
  if (!isRecord(input)
    || !hasOnlyKeys(input, ['version', 'agentId', 'mode', 'allowedCalls', 'policyDigest'])
    || input.version !== 1
    || typeof input.agentId !== 'string' || input.agentId.length === 0
    || input.mode !== 'native-allowlist'
    || !Array.isArray(input.allowedCalls)
    || typeof input.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.policyDigest)) {
    throw new TypeError('initialize nativeToolPolicy is malformed or unsupported')
  }
  const allowedCalls: NativeToolAllowedCall[] = input.allowedCalls.map((value, index) => {
    if (!isRecord(value)
      || !hasOnlyKeys(value, ['toolName', 'argumentEquals'])
      || typeof value.toolName !== 'string' || value.toolName.length === 0
      || value.toolName.includes('*')
      || (Object.hasOwn(value, 'argumentEquals')
        && (!isRecord(value.argumentEquals)
          || !hasOnlyKeys(value.argumentEquals, Object.keys(value.argumentEquals))
          || Object.keys(value.argumentEquals).length === 0
          || !Object.values(value.argumentEquals).every(isJsonValue)))) {
      throw new TypeError(`initialize nativeToolPolicy.allowedCalls[${index}] is malformed`)
    }
    if (!knownToolNames.has(value.toolName)) {
      throw new TypeError(`initialize nativeToolPolicy names unknown tool "${value.toolName}"`)
    }
    const argumentEquals = value.argumentEquals as Record<string, JsonValue> | undefined
    return Object.freeze({
      toolName: value.toolName,
      ...(argumentEquals === undefined ? {} : { argumentEquals: detachAndFreeze(argumentEquals) as Readonly<Record<string, JsonValue>> }),
    })
  })
  for (let index = 0; index < allowedCalls.length; index += 1) {
    for (let other = index + 1; other < allowedCalls.length; other += 1) {
      const left = allowedCalls[index]
      const right = allowedCalls[other]
      if (left === undefined || right === undefined) continue
      if (left.toolName === right.toolName && selectorsOverlap(left, right)) {
        throw new TypeError(`initialize nativeToolPolicy has duplicate or overlapping selectors for "${left.toolName}"`)
      }
    }
  }
  const unsigned = {
    version: 1 as const,
    agentId: input.agentId,
    mode: 'native-allowlist' as const,
    allowedCalls: Object.freeze(allowedCalls),
  }
  const expected = canonicalDigest(unsigned)
  if (input.policyDigest !== expected) throw new TypeError('initialize nativeToolPolicy digest does not match its contents')
  return Object.freeze({ ...unsigned, policyDigest: expected })
}

/** Decide whether one effective tool call matches exactly one signed selector. */
export function nativeToolPolicyAllows(
  policy: NativeToolPolicy,
  toolName: string,
  args: unknown,
  declaredDiscriminators: readonly string[] | undefined,
): boolean {
  return policy.allowedCalls.some((selector) => {
    if (selector.toolName !== toolName) return false
    const expected = selector.argumentEquals
    if (expected === undefined) return true
    if (!isRecord(args)) return false
    const keys = Object.keys(expected)
    if (keys.some((key) => {
      const actual = args[key]
      const wanted = expected[key]
      return !Object.hasOwn(args, key) || actual === undefined || wanted === undefined
        || canonicalJson(actual as JsonValue) !== canonicalJson(wanted)
    })) return false
    const allowsExtra = declaredDiscriminators !== undefined
      && keys.every(key => declaredDiscriminators.includes(key))
    return allowsExtra || Object.keys(args).length === keys.length
  })
}
