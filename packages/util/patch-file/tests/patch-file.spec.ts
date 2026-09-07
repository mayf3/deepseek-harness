import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import {
  anchorInsertedPluginNames,
  mutatePatchFile,
  parsePatchList,
  PatchDocument,
  readPatchListFile,
} from '../src/index.ts'

const SAMPLE = `# top comment
- id: message-feedback # trailing
  disabled: true

# insert block
- insert:
    - id: tool-foo
      name: dsh-tool-foo
      config: {}
    - id: group-a
      name: cordis:group
      group: true
      config:
        - id: nested-row
          name: dsh-nested
- id: tool-bash
  disabled: !!js process.platform === 'win32'
  config:
    a: 1 # keep me
`

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-patch-file-'))
}

describe('PatchDocument', () => {
  it('reads an empty or comment-only file as an empty list', () => {
    expect(PatchDocument.parse('', 'x.yml').toString()).toBe('[]\n')
    expect(PatchDocument.parse('# only a comment\n', 'x.yml').toString()).toContain('[]')
  })

  it('refuses a root that is not a sequence, a non-map item, and invalid YAML', () => {
    expect(() => PatchDocument.parse('a: 1\n', 'x.yml')).toThrow('must be a top-level YAML array')
    expect(() => PatchDocument.parse('- just-a-string\n', 'x.yml')).toThrow('entry 1 in x.yml must be a mapping')
    expect(() => PatchDocument.parse('- id: [\n', 'x.yml')).toThrow('x.yml is not valid YAML')
  })

  it('reads and sets id-targeted patch keys while keeping comments and !!js scalars', () => {
    const document = PatchDocument.parse(SAMPLE, 'x.yml')
    expect(document.hasRow('message-feedback')).toBe(true)
    expect(document.hasRow('tool-foo')).toBe(false)
    expect(document.rowField('message-feedback', 'disabled')).toBe(true)
    expect(document.rowField('message-feedback', 'config')).toBeUndefined()
    expect(document.rowField('absent', 'disabled')).toBeUndefined()
    // A `!!js` scalar reads as its source text; the writer never evaluates it.
    expect(document.rowField('tool-bash', 'disabled')).toBe("process.platform === 'win32'")

    document.setRowField('tool-bash', 'config', { a: 1, b: 'x' })
    document.setRowField('new-row', 'disabled', true)
    const text = document.toString()
    expect(text).toContain('# top comment')
    expect(text).toContain('- id: message-feedback # trailing')
    expect(text).toContain("disabled: !!js process.platform === 'win32'")
    expect(text).toContain('- id: new-row\n  disabled: true')
    expect(text).toMatch(/config:\n\s+a: 1\n\s+b: x/)
    // The rewritten text is what the boot parser loads.
    const rows = parsePatchList('spec', 'x.yml', text, 'patches')
    expect(rows.find(patch => patch.id === 'tool-bash')?.config).toEqual({ a: 1, b: 'x' })
    expect(isJsExpr(rows.find(patch => patch.id === 'tool-bash')?.disabled)).toBe(true)
  })

  it('refuses to set id or insert through the key setter', () => {
    const document = PatchDocument.parse(SAMPLE, 'x.yml')
    expect(() => { document.setRowField('tool-bash', 'id', 'other') }).toThrow('id is not a settable key')
    expect(() => { document.setRowField('tool-bash', 'insert', []) }).toThrow('insert is not a settable key')
  })

  it('deletes keys and removes a patch reduced to its id', () => {
    const document = PatchDocument.parse(SAMPLE, 'x.yml')
    expect(document.deleteRowField('absent', 'disabled')).toBe(false)
    expect(document.deleteRowField('tool-bash', 'absent')).toBe(false)
    expect(document.deleteRowField('tool-bash', 'config')).toBe(true)
    expect(document.hasRow('tool-bash')).toBe(true)
    expect(document.deleteRowField('message-feedback', 'disabled')).toBe(true)
    expect(document.hasRow('message-feedback')).toBe(false)
    const text = document.toString()
    expect(text).not.toContain('message-feedback')
    expect(text).toContain('# top comment')
    expect(text).not.toContain('keep me')
  })

  it('appends inserted rows to the root list, to a group, and creates the patch when absent', () => {
    const document = PatchDocument.parse(SAMPLE, 'x.yml')
    document.appendInsert({ id: 'tool-bar', name: 'dsh-tool-bar' })
    document.appendInsert({ id: 'in-group', name: 'dsh-in-group', config: { k: 1 } }, 'agents')
    document.appendInsert({ id: 'in-group-2', name: 'dsh-in-group-2' }, 'agents')
    const rows = parsePatchList('spec', 'x.yml', document.toString(), 'patches')
    const root = rows.find(patch => patch.insert !== undefined && patch.id === undefined)
    expect(root?.insert?.map(row => row.id)).toEqual(['tool-foo', 'group-a', 'tool-bar'])
    const grouped = rows.find(patch => patch.id === 'agents')
    expect(grouped?.insert?.map(row => row.id)).toEqual(['in-group', 'in-group-2'])
    expect(grouped?.insert?.[0]?.config).toEqual({ k: 1 })
  })

  it('refuses to insert a row id the file already inserts', () => {
    const document = PatchDocument.parse(SAMPLE, 'x.yml')
    expect(() => { document.appendInsert({ id: 'nested-row', name: 'x' }) }).toThrow('"nested-row" is already inserted')
  })

  it('finds and removes inserted rows, including inside inserted groups', () => {
    const document = PatchDocument.parse(SAMPLE, 'x.yml')
    expect(document.insertedRow('tool-foo')).toEqual({ id: 'tool-foo', name: 'dsh-tool-foo', config: {} })
    expect(document.insertedRow('nested-row')).toEqual({ id: 'nested-row', name: 'dsh-nested' })
    expect(document.insertedRow('absent')).toBeUndefined()
    expect(document.removeInsert('absent')).toBe(false)
    expect(document.removeInsert('nested-row')).toBe(true)
    expect(document.insertedRow('nested-row')).toBeUndefined()
    expect(document.removeInsert('tool-foo')).toBe(true)
    expect(document.removeInsert('group-a')).toBe(true)
    // The insert patch emptied by the removals is gone with its comment block.
    expect(document.toString()).not.toContain('insert:')
    expect(document.toString()).toContain('- id: tool-bash')
  })

  it('skips non-map items and non-group rows while walking insert lists', () => {
    const document = PatchDocument.parse(
      '- insert:\n    - plain\n    - id: leaf\n      name: x\n      group: true\n      config: notalist\n', 'x.yml',
    )
    expect(document.insertedRow('leaf')).toEqual({ id: 'leaf', name: 'x', group: true, config: 'notalist' })
    expect(document.insertedRow('missing')).toBeUndefined()
  })

  it('refuses an insert patch whose list is not a sequence', () => {
    const document = PatchDocument.parse('- insert: 1\n', 'x.yml')
    expect(() => document.insertedRow('x')).toThrow('insert patch must hold a list of rows')
  })
})

describe('parsePatchList', () => {
  it('reads empty text as an empty layer and anchors relative names to the file', () => {
    expect(parsePatchList('spec', '/tmp/x.yml', '', 'patches')).toEqual([])
    const rows = parsePatchList('spec', '/tmp/dir/x.yml', [
      '- insert:',
      '    - id: rel',
      '      name: ./plugin.js',
      '    - id: bare',
      '      name: dsh-bare',
      '    - id: g',
      '      name: cordis:group',
      '      group: true',
      '      config:',
      '        - id: up',
      '          name: ../up.js',
      '- id: other',
      '  disabled: true',
    ].join('\n'), 'overlay')
    const insert = rows[0]?.insert ?? []
    expect(insert[0]?.name).toBe(pathToFileURL(resolve('/tmp/dir', './plugin.js')).href)
    expect(insert[1]?.name).toBe('dsh-bare')
    expect((insert[2]?.config as { name: string }[])[0]?.name).toBe(pathToFileURL(resolve('/tmp/dir', '../up.js')).href)
    expect(rows[1]).toEqual({ id: 'other', disabled: true })
  })

  it('fails loud on invalid YAML, a non-array root, and a non-map entry', () => {
    expect(() => parsePatchList('spec', 'x.yml', '- id: [\n', 'overlay')).toThrow('spec: failed to parse overlay x.yml')
    expect(() => parsePatchList('spec', 'x.yml', 'a: 1\n', 'patches')).toThrow('patches x.yml must be a top-level YAML array')
    expect(() => parsePatchList('spec', 'x.yml', '- 1\n', 'patches')).toThrow('patches entry 1 in x.yml must be a mapping')
  })

  it('anchors names in place and returns the same list', () => {
    const patches = [{ insert: [{ id: 'a', name: './a.js' }] }]
    expect(anchorInsertedPluginNames(patches, '/tmp/dir/x.yml')).toBe(patches)
    expect(patches[0]?.insert[0]?.name).toBe(pathToFileURL('/tmp/dir/a.js').href)
  })

  it('anchors the rows a config override sets, and leaves other patches and non-row items alone', () => {
    const patches = [
      { id: 'g', config: [{ id: 'c', name: './c.js' }, 'not a row', { flag: true }] },
      { id: 'other', disabled: true },
      { disabled: true },
      { id: 'scalar', config: { name: './not-a-row.js' } },
    ]
    anchorInsertedPluginNames(patches, '/tmp/dir/x.yml')
    expect(patches[0]?.config).toEqual([{ id: 'c', name: pathToFileURL('/tmp/dir/c.js').href }, 'not a row', { flag: true }])
    expect(patches[3]?.config).toEqual({ name: './not-a-row.js' })
  })
})

describe('readPatchListFile', () => {
  it('reads undefined for an absent file, the list for a present one, and throws for an unreadable one', async () => {
    const dir = await tempDir()
    expect(await readPatchListFile('spec', join(dir, 'absent.yml'), 'patches')).toBeUndefined()
    await writeFile(join(dir, 'x.yml'), '- id: a\n  disabled: true\n')
    expect(await readPatchListFile('spec', join(dir, 'x.yml'), 'patches')).toEqual([{ id: 'a', disabled: true }])
    await expect(readPatchListFile('spec', dir, 'patches')).rejects.toThrow('spec: failed to read patches')
  })
})

describe('mutatePatchFile', () => {
  it('creates the file under the lock, replaces it atomically, and reads it back', async () => {
    const dir = await tempDir()
    const file = join(dir, 'nested', 'cordis.patch.yml')
    const rows = await mutatePatchFile(file, (document) => {
      document.setRowField('tool-web', 'disabled', true)
      document.appendInsert({ id: 'tool-foo', name: 'dsh-tool-foo' })
    }, { binName: 'spec', mode: 0o600, dirMode: 0o700 })
    expect(rows).toEqual([{ id: 'tool-web', disabled: true }, { insert: [{ id: 'tool-foo', name: 'dsh-tool-foo' }] }])
    expect(await readFile(file, 'utf8')).toBe('- id: tool-web\n  disabled: true\n- insert:\n    - id: tool-foo\n      name: dsh-tool-foo\n')
    expect(existsSync(`${file}.lock`)).toBe(false)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)

    // A second edit keeps the author's comment and reverts only its own key.
    await writeFile(file, `# mine\n${await readFile(file, 'utf8')}`)
    const reverted = await mutatePatchFile(file, (document) => {
      document.deleteRowField('tool-web', 'disabled')
    }, { binName: 'spec', mode: 0o600, waitMs: 500 })
    expect(reverted).toEqual([{ insert: [{ id: 'tool-foo', name: 'dsh-tool-foo' }] }])
    expect(await readFile(file, 'utf8')).toContain('# mine')
  })

  it('writes nothing when the edit changes nothing', async () => {
    const dir = await tempDir()
    const file = join(dir, 'cordis.patch.yml')
    expect(await mutatePatchFile(file, () => {}, { binName: 'spec', mode: 0o600 })).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a file that exists but cannot be read', async () => {
    const dir = await tempDir()
    const file = join(dir, 'cordis.patch.yml')
    await writeFile(file, '[]\n', { mode: 0o000 })
    await expect(mutatePatchFile(file, () => {}, { binName: 'spec', mode: 0o600 }))
      .rejects.toThrow('spec: failed to read patches')
    expect(existsSync(`${file}.lock`)).toBe(false)
  })

  it('keeps the comment above a removed row', async () => {
    const dir = await tempDir()
    const file = join(dir, 'cordis.patch.yml')
    await writeFile(file, '# first\n- id: a\n  disabled: true\n# second\n- id: b\n  disabled: true\n# third\n- id: c\n  disabled: true\n')
    await mutatePatchFile(file, (document) => { document.deleteRowField('a', 'disabled') }, { binName: 'spec', mode: 0o600 })
    expect(await readFile(file, 'utf8')).toBe('# first\n# second\n- id: b\n  disabled: true\n# third\n- id: c\n  disabled: true\n')
    // Removing from the end twice keeps the file's own comment order.
    await mutatePatchFile(file, (document) => {
      document.deleteRowField('c', 'disabled')
      document.deleteRowField('b', 'disabled')
    }, { binName: 'spec', mode: 0o600 })
    expect(await readFile(file, 'utf8')).toBe('[]\n\n# first\n# second\n# third\n')
  })

  it('reports a file that does not parse', async () => {
    const dir = await tempDir()
    const file = join(dir, 'cordis.patch.yml')
    await writeFile(file, 'a: 1\n')
    await expect(mutatePatchFile(file, () => {}, { binName: 'spec', mode: 0o600 }))
      .rejects.toThrow('must be a top-level YAML array')
  })
})
