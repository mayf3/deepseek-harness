import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertFixtureInventory,
  fixtureIdentity,
  normalizeAria,
  normalizeWebSessionVolatiles,
  realizeSeedFixture,
  recordedSessionFixturePath,
  selectedSessionFixture,
  type WebScaffold,
} from './scaffold.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Web snapshot generation filenames', () => {
  it('normalizes the live Session cwd instead of its scaffold parent on Windows', () => {
    const scaffoldRoot = 'C:\\Users\\dsh\\AppData\\Local\\Temp\\dsh-web-e2e-ws-test'
    const sessionCwd = `${scaffoldRoot}\\workspace`
    const log = [
      JSON.stringify({
        type: 'session', version: 1, id: 'stable-session-windows', createdAt: 0,
        cwd: sessionCwd, delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'user/message',
        data: {
          content: [{
            type: 'text',
            text: `System workspace: "${sessionCwd}". Nested file: ${sessionCwd}/notes.txt`,
          }],
          opaque: {
            sibling: `${sessionCwd}-copy`,
            parentPrefix: `${scaffoldRoot}ed`,
          },
        },
      }),
      '',
    ].join('\n')

    const [headerLine, eventLine] = normalizeWebSessionVolatiles(log, scaffoldRoot).split('\n')
    expect(JSON.parse(headerLine!) as unknown).toMatchObject({ cwd: '{{cwd}}' })
    expect(JSON.parse(eventLine!) as unknown).toMatchObject({
      data: {
        content: [{
          text: 'System workspace: "{{cwd}}". Nested file: {{cwd}}/notes.txt',
        }],
        opaque: {
          sibling: `${sessionCwd}-copy`,
          parentPrefix: `${scaffoldRoot}ed`,
        },
      },
    })
  })

  it('normalizes native and browser-rendered Windows workspace paths', () => {
    const cwd = 'C:\\Users\\runner\\AppData\\Local\\Temp\\dsh-web-e2e-ws-abc'
    const escapedCwd = cwd.replaceAll('\\', '\\\\')
    expect(normalizeAria([
      `${escapedCwd}\\\\workspace\\\\file.txt`,
      `${cwd}\\workspace\\file.txt`,
      `${cwd.replaceAll('\\', '/')}/workspace/file.txt`,
      'dsh-web-e2e-ws-abc',
    ].join('\n'), cwd, false)).toBe([
      '{{cwd}}\\\\workspace\\\\file.txt',
      '{{cwd}}\\workspace\\file.txt',
      '{{cwd}}/workspace/file.txt',
      '{{workspace}}',
    ].join('\n'))
  })

  it('realizes Windows cwd and identity tokens as JSON string values', () => {
    const recordedCwd = 'D:\\recorded\\workspace'
    const workspaceCwd = 'C:\\Users\\runner\\work\\deepseek-harness'
    const fixture = [
      JSON.stringify({
        type: 'session', version: 1, id: '{{session:1}}', createdAt: 0,
        cwd: recordedCwd, delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'event',
        data: {
          placeholderPath: '{{cwd}}\\placeholder.txt',
          recordedPath: `${recordedCwd}\\recorded.txt`,
          child: '{{session:2}}',
          message: '{{message:1}}',
          opaque: '{ "literal": "\\\\b", "keep": true }',
        },
      }),
      '',
    ].join('\n')
    const scaffold = { workspaceCwd } as WebScaffold

    const realized = realizeSeedFixture(scaffold, fixture, 'live-session')
    const [headerLine, eventLine] = realized.split('\n')
    const header = JSON.parse(headerLine!) as { id: string; cwd: string }
    const event = JSON.parse(eventLine!) as { data: Record<string, string> }

    expect(header).toMatchObject({ id: 'live-session', cwd: workspaceCwd })
    expect(event.data).toEqual({
      placeholderPath: `${workspaceCwd}\\placeholder.txt`,
      recordedPath: `${workspaceCwd}\\recorded.txt`,
      child: 'live-session-child-2',
      message: fixtureIdentity('message', 1),
      opaque: '{ "literal": "\\\\b", "keep": true }',
    })
    expect(realized.endsWith('\n')).toBe(true)
    expect(realizeSeedFixture(scaffold, realized, 'live-session')).toBe(realized)
  })

  it('collapses a tokenized recorded cwd before realizing its generic cwd prefix', () => {
    const workspaceCwd = 'C:\\Users\\runner\\work\\deepseek-harness'
    const recordedCwd = '{{cwd}}\\workspace'
    const fixture = [
      JSON.stringify({
        type: 'session', version: 1, id: '{{sessionId}}', createdAt: 0,
        cwd: recordedCwd, delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'event', data: { path: `${recordedCwd}\\nav-a.md` },
      }),
      '',
    ].join('\n')

    const [headerLine, eventLine] = realizeSeedFixture(
      { workspaceCwd } as WebScaffold,
      fixture,
      'live-session',
    ).split('\n')

    expect(JSON.parse(headerLine!) as unknown).toMatchObject({ cwd: workspaceCwd })
    expect(JSON.parse(eventLine!) as unknown).toMatchObject({
      data: { path: `${workspaceCwd}\\nav-a.md` },
    })
  })

  it('selects the highest parent and child generations without counting retained inputs twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)
    for (const name of [
      'session.jsonl',
      'session.v2.jsonl',
      'session.1.jsonl',
      'session.1.v1.jsonl',
    ]) await writeFile(join(root, name), '')

    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .resolves.toBe(join(root, 'session.v2.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.1.jsonl')))
      .resolves.toBe(join(root, 'session.1.v1.jsonl'))
    await expect(selectedSessionFixture(join(root, 'replay.override.json')))
      .resolves.toBe(join(root, 'replay.override.json'))
  })

  it('leaves an absent override-only parent fixture unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)

    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .resolves.toBe(join(root, 'session.jsonl'))
  })

  it('selects a committed sibling when the requested older generation is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)
    await writeFile(join(root, 'session.v1.jsonl'), '')

    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .resolves.toBe(join(root, 'session.v1.jsonl'))
  })

  it('records beside an older generation and preserves the parent or child role', () => {
    const fixtures = join('/', 'fixtures')
    expect(recordedSessionFixturePath(join(fixtures, 'session.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.2.jsonl'), 3))
      .toBe(join(fixtures, 'session.2.v3.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.v1.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(() => recordedSessionFixturePath(join(fixtures, 'notes.jsonl'), 1))
      .toThrow('invalid Session fixture path')
  })

  it('treats retained generations as one exact inventory role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'session.jsonl'), `${JSON.stringify({
      type: 'session', version: 0, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'session.v1.jsonl'), `${JSON.stringify({
      type: 'session', version: 1, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'ui.expected.md'), 'stable\n')

    await expect(assertFixtureInventory(root, ['session.jsonl', 'ui.expected.md']))
      .resolves.toBeUndefined()
  })
})
