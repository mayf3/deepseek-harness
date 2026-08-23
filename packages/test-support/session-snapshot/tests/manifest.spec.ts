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

  it.each([
    ['', 'manifest must be a mapping'],
    ['version: 2\nprofile: acp\n', 'manifest.version must equal 1'],
    ['version: 1\nprofile: private\n', 'manifest.profile must be headless, sdk, acp, or web'],
    ['version: 1\nprofile: acp\nextra: true\n', 'manifest has unknown field(s): extra'],
    ['version: 1\nprofile: acp\nsession: {}\n', 'manifest.session.source must be a non-empty string'],
    ['version: 1\nprofile: acp\nsession:\n  source: /tmp/session.jsonl\n', 'manifest.session.source must be a relative POSIX path'],
    ['version: 1\nprofile: acp\nsession:\n  source: ..\\session.jsonl\n', 'manifest.session.source must be a relative POSIX path'],
    ['version: 1\nprofile: !!js acp\n', 'invalid YAML'],
  ])('rejects invalid metadata', (source, message) => {
    expect(() => parseSnapshotManifest(source, 'case/snapshot.yml')).toThrow(message)
  })
})
