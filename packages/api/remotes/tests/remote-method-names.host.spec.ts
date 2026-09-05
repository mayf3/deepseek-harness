/**
 * A Remote method is reached on the browser as `ctx.remote.<namespace>.<method>`,
 * a member of the namespace service the client gateway mounts. The mount
 * refuses a method named after one of that service's own members — its
 * fields and its private `install`/`remove` helpers — and it refuses at page
 * load, after every unit suite passed. This spec reads the reserved names
 * off the gateway's own source and checks every `@Remote('<name>')` in the
 * workspace against them, so the collision fails here instead.
 */

import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** The names the client namespace service keeps for itself. */
function reservedMethodNames(): Set<string> {
  const source = readFileSync(join(ROOT, 'packages/api/gateway/src/client/index.ts'), 'utf8')
  const fields = /const REMOTE_NAMESPACE_FIELDS = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1]
  const classBody = /class RemoteNamespaceService extends Service \{([\s\S]*?)\n\}/.exec(source)?.[1]
  if (fields === undefined || classBody === undefined) {
    throw new Error('the client gateway no longer spells its namespace service the way this spec reads it')
  }
  const reserved = new Set([...fields.matchAll(/'([^']+)'/g)].map(match => match[1] as string))
  for (const match of classBody.matchAll(/^ {2}(?:private |static |readonly |get |async )*([A-Za-z_$][\w$]*)\s*[(:=]/gm)) {
    reserved.add(match[1] as string)
  }
  return reserved
}

describe('Remote method names', () => {
  it('never name a member of the client namespace service', () => {
    const reserved = reservedMethodNames()
    expect(reserved.has('install')).toBe(true)
    expect(reserved.has('remove')).toBe(true)
    const offenders: string[] = []
    for (const file of globSync('packages/*/*/src/**/*.ts', { cwd: ROOT })) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      for (const match of source.matchAll(/@Remote\(\s*'([^']+)'/g)) {
        const method = match[1] as string
        if (reserved.has(method)) offenders.push(`${file}: @Remote('${method}')`)
      }
    }
    expect(offenders).toEqual([])
  })
})
