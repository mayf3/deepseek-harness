import { describe, expect, it } from 'vitest'
import { parseSnapshotManifest } from '../src/manifest.ts'

describe('snapshot manifest', () => {
  it('parses an owning scenario', () => {
    expect(parseSnapshotManifest('version: 1\nprofile: headless\n')).toEqual({
      version: 1,
      profile: 'headless',
    })
  })

  it('parses a read-only session reference', () => {
    expect(parseSnapshotManifest([
      'version: 1',
      'profile: web',
      'session:',
      '  source: ../../session/tool-call-turn/session.jsonl',
      '',
    ].join('\n'))).toEqual({
      version: 1,
      profile: 'web',
      session: { source: '../../session/tool-call-turn/session.jsonl' },
    })
  })

  it('parses composition, recording, header, and exceptional replay metadata', () => {
    expect(parseSnapshotManifest([
      'version: 1',
      'profile: sdk',
      'composition: continuable-subagent',
      'recording: authored',
      'header:',
      '  class: continuable-subagent',
      '  pin: true',
      '  systemPromptSource: text-turn',
      '  toolSchemasSource: text-turn',
      '  childSystemPrompts: [1]',
      '  childToolSchemas: [1, 2]',
      '  changes: 1',
      'replay:',
      '  override: true',
      '',
    ].join('\n'))).toEqual({
      version: 1,
      profile: 'sdk',
      composition: 'continuable-subagent',
      recording: 'authored',
      header: {
        class: 'continuable-subagent',
        pin: true,
        systemPromptSource: 'text-turn',
        toolSchemasSource: 'text-turn',
        childSystemPrompts: [1],
        childToolSchemas: [1, 2],
        changes: 1,
      },
      replay: { override: true },
    })
  })

  it.each([
    ['', 'manifest must be a mapping'],
    ['version: 2\nprofile: acp\n', 'manifest.version must equal 1'],
    ['version: 1\nprofile: private\n', 'manifest.profile must be headless, sdk, acp, or web'],
    ['version: 1\nprofile: acp\nextra: true\n', 'manifest has unknown field(s): extra'],
    ['version: 1\nprofile: acp\ncomposition: Not_Safe\n', 'manifest.composition must be a lower-kebab-case name'],
    ['version: 1\nprofile: acp\nrecording: maybe\n', 'manifest.recording must be live or authored'],
    ['version: 1\nprofile: acp\nheader: {}\n', 'manifest.header.class must be a lower-kebab-case name'],
    ['version: 1\nprofile: acp\nheader:\n  class: base\n  pin: false\n', 'manifest.header.pin must equal true when present'],
    ['version: 1\nprofile: acp\nheader:\n  class: base\n  childToolSchemas: [1, 1]\n', 'manifest.header.childToolSchemas must be an array of unique positive integers'],
    ['version: 1\nprofile: acp\nheader:\n  class: base\n  changes: -1\n', 'manifest.header.changes must be a non-negative integer'],
    ['version: 1\nprofile: acp\nreplay:\n  override: false\n', 'manifest.replay.override must equal true'],
    ['version: 1\nprofile: acp\nsession: {}\n', 'manifest.session.source must be a non-empty string'],
    ['version: 1\nprofile: acp\nsession:\n  source: /tmp/session.jsonl\n', 'manifest.session.source must be a relative POSIX path'],
    ['version: 1\nprofile: acp\nsession:\n  source: ..\\session.jsonl\n', 'manifest.session.source must be a relative POSIX path'],
    ['version: 1\nprofile: !!js acp\n', 'invalid YAML'],
  ])('rejects invalid metadata', (source, message) => {
    expect(() => parseSnapshotManifest(source, 'case/snapshot.yml')).toThrow(message)
  })
})
