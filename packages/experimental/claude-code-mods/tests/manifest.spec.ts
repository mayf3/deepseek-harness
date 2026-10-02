import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOKS_MODULE_EXTENSIONS, parseHooksJson, parseModManifest, readModManifest, resolvePluginOptions } from '../src/manifest.ts'
import { describeMatcher, eventMatches, isEventPattern, KNOWN_EVENTS, matcherMatches } from '../src/matcher.ts'
import { createToolNameAliases, DEFAULT_TOOL_ALIASES } from '../src/tool-names.ts'

const FIXTURES = resolve(import.meta.dirname, 'fixtures')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-mods-'))
  dirs.push(dir)
  return dir
}

describe('parseModManifest', () => {
  it('reads the name, version, description, and userConfig defaults', () => {
    const manifest = parseModManifest({
      name: 'first-mod', version: '0.1.0', description: 'd',
      userConfig: { greeting: { type: 'string', default: 'hi' }, count: { type: 'number' }, list: { default: ['a'] } },
    }, 'plugin.json')
    expect(manifest).toEqual({ name: 'first-mod', version: '0.1.0', description: 'd', userConfigDefaults: { greeting: 'hi', list: ['a'] } })
  })

  it.each([
    [null, /must be a JSON object/],
    [{ name: 'Bad Name' }, /"name" must be lowercase/],
    [{ name: 'claude-x' }, undefined],
    [{ name: 'ok', version: 1 }, /"version" must be a string/],
    [{ name: 'ok', description: 1 }, /"description" must be a string/],
    [{ name: 'ok', userConfig: [] }, /"userConfig" must be an object/],
    [{ name: 'ok', userConfig: { f: 1 } }, /userConfig\.f must be an object/],
    [{ name: 'ok', userConfig: { f: { default: { nested: true } } } }, /userConfig\.f\.default must be/],
  ])('validates %j', (raw, error) => {
    if (error === undefined) expect(() => parseModManifest(raw, 'p')).not.toThrow()
    else expect(() => parseModManifest(raw, 'p')).toThrow(error)
  })
})

describe('parseHooksJson', () => {
  const root = resolve('/plugins/demo')
  const hooksJson = join(root, 'hooks', 'hooks.json')

  it('resolves the one module path against hooks.json and notes settings hooks', () => {
    expect(parseHooksJson({ modules: ['./register.js'] }, hooksJson)).toEqual({ modulePath: join(root, 'hooks', 'register.js'), hasSettingsHooks: false })
    expect(parseHooksJson({ modules: ['../lib/mod.mts'], hooks: {} }, hooksJson)).toEqual({ modulePath: join(root, 'lib', 'mod.mts'), hasSettingsHooks: true })
    expect(HOOKS_MODULE_EXTENSIONS).toContain('.tsx')
  })

  it.each([
    [null, /must be a JSON object/],
    [{}, /exactly one module path/],
    [{ modules: ['./a.js', './b.js'] }, /exactly one module path/],
    [{ modules: [1] }, /exactly one module path/],
    [{ modules: ['/abs/register.js'] }, /must be relative/],
    [{ modules: ['../../outside.js'] }, /stay inside the plugin directory/],
    [{ modules: ['./register.json'] }, /must end in one of/],
  ])('rejects %j', (raw, error) => {
    expect(() => parseHooksJson(raw, hooksJson)).toThrow(error)
  })
})

describe('readModManifest and resolvePluginOptions', () => {
  it('reads a fixture directory and overlays configured options on manifest defaults', () => {
    const directory = readModManifest('first-mod', FIXTURES)
    expect(directory.root).toBe(join(FIXTURES, 'first-mod'))
    expect(directory.modulePath).toBe(join(FIXTURES, 'first-mod', 'hooks', 'register.js'))
    expect(directory.hasSettingsHooks).toBe(false)
    expect(resolvePluginOptions(directory.manifest, undefined)).toEqual({ greeting: 'Claude has made' })
    expect(resolvePluginOptions(directory.manifest, { greeting: 'The model made', extra: 1 })).toEqual({ greeting: 'The model made', extra: 1 })
    expect(readModManifest(join(FIXTURES, 'guard-mod'), '/elsewhere').hasSettingsHooks).toBe(true)
  })

  it('fails loud on a missing directory, unreadable file, or invalid JSON', () => {
    expect(() => readModManifest(join(FIXTURES, 'missing'), FIXTURES)).toThrow(/plugin\.json: cannot read/)
    const dir = scratch()
    mkdirSync(join(dir, '.claude-plugin'))
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{ not json')
    expect(() => readModManifest(dir, FIXTURES)).toThrow(/invalid JSON/)
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{ "name": "x" }')
    expect(() => readModManifest(dir, FIXTURES)).toThrow(/hooks\.json: cannot read/)
  })
})

describe('event patterns and matchers', () => {
  it('knows Claude Code\'s event names and globs', () => {
    expect(KNOWN_EVENTS.has('tool.call')).toBe(true)
    expect(isEventPattern('tool.call')).toBe(true)
    expect(isEventPattern('tool.calls')).toBe(false)
    expect(isEventPattern('*')).toBe(true)
    expect(isEventPattern('classic.*')).toBe(false)
    expect(isEventPattern('telemetry.*')).toBe(true)
    expect(isEventPattern('.*')).toBe(false)
  })

  it('matches exact names, namespace globs, and the star without telemetry', () => {
    expect(eventMatches('tool.call', 'tool.call')).toBe(true)
    expect(eventMatches('tool.call', 'tool.check')).toBe(false)
    expect(eventMatches('tool.*', 'tool.check')).toBe(true)
    expect(eventMatches('tool.*', 'turn.start')).toBe(false)
    expect(eventMatches('*', 'turn.start')).toBe(true)
    expect(eventMatches('*', 'telemetry.log')).toBe(false)
    expect(eventMatches('telemetry.*', 'telemetry.log')).toBe(true)
  })

  it('compares scalars by equality, arrays by membership, and regular expressions by test', () => {
    const input = { tool: 'mcp__github__issues', count: 3, flag: true }
    expect(matcherMatches({ tool: 'mcp__github__issues' }, input)).toBe(true)
    expect(matcherMatches({ tool: 'Bash' }, input)).toBe(false)
    expect(matcherMatches({ tool: ['Edit', 'mcp__github__issues'] }, input)).toBe(true)
    expect(matcherMatches({ tool: /^mcp__github__/ }, input)).toBe(true)
    expect(matcherMatches({ count: /^3$/ }, input)).toBe(true)
    expect(matcherMatches({ flag: /true/ }, input)).toBe(false)
    expect(matcherMatches({ tool: 'x', count: 3 }, input)).toBe(false)
    expect(matcherMatches({ tool: 'x' }, 'not an object')).toBe(false)
    expect(matcherMatches({}, input)).toBe(true)
  })

  it('describes matchers the way claude plugin validate prints them', () => {
    expect(describeMatcher(undefined)).toBe('')
    expect(describeMatcher({ component: 'Spinner' })).toBe('{component=Spinner}')
    expect(describeMatcher({ tool: ['Edit', 'Write'], id: /^T-/ })).toBe('{tool=Edit|Write,id=/^T-/}')
  })
})

describe('tool-name aliases', () => {
  it('translates both ways, falling back to the name itself, and takes overrides', () => {
    const aliases = createToolNameAliases({ Bash: 'pwsh', Custom: 'my_tool' })
    expect(DEFAULT_TOOL_ALIASES.Bash).toBe('bash')
    expect(aliases.toHarness('Bash')).toBe('pwsh')
    expect(aliases.toMod('pwsh')).toBe('Bash')
    expect(aliases.toMod('bash')).toBe('bash')
    expect(aliases.toHarness('Custom')).toBe('my_tool')
    expect(aliases.toHarness('Read')).toBe('read')
    expect(aliases.toMod('read')).toBe('Read')
    expect(aliases.toMod('unknown_tool')).toBe('unknown_tool')
  })
})
