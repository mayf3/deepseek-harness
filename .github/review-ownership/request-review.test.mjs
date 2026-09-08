import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  classifyChangedFiles,
  createGitHubApi,
  isTestPath,
  listPullRequestFiles,
  normalizeRepositoryPath,
  parseOwnership,
  planReviewers,
  requestReviews,
} from './request-review.mjs'

const ownershipSource = readFileSync(new URL('CODEOWNERS', import.meta.url), 'utf8')

const pullRequestEvent = ({ author = 'author', changedFiles = 1, draft = false } = {}) => ({
  repository: { full_name: 'deepseek-harness/deepseek-harness' },
  pull_request: {
    number: 42,
    draft,
    changed_files: changedFiles,
    user: { login: author },
  },
})

test('loads the repository ownership policy without test-only directory rules', () => {
  const rules = parseOwnership(ownershipSource)
  const ownersByPattern = new Map(rules.map(rule => [rule.pattern, rule.owners]))
  assert.equal(rules.length, 58)
  assert.equal(rules.some(rule => rule.pattern === '/benchmarks/'), false)
  assert.equal(rules.some(rule => rule.pattern === '/snapshots/'), false)
  assert.equal(rules.some(rule => rule.pattern === '/packages/test-support/'), false)
  assert.deepEqual(ownersByPattern.get('/apps/cli/'), ['@turtle1999'])
  assert.deepEqual(ownersByPattern.get('/docs/'), ['@turtle1999'])
  assert.deepEqual(ownersByPattern.get('/packages/core/'), ['@tianyicui', '@turtle1999', '@mektpoy'])
  assert.deepEqual(ownersByPattern.get('/packages/llm/'), ['@LegGasai'])
  assert.deepEqual(ownersByPattern.get('/packages/preset/'), ['@LegGasai', '@turtle1999'])
  assert.deepEqual(ownersByPattern.get('/packages/session/'), ['@tianyicui', '@turtle1999', '@mektpoy'])
  assert.deepEqual(ownersByPattern.get('/packages/subagent/'), ['@Dudu-0223'])
  assert.deepEqual(ownersByPattern.get('/packages/web/'), ['@imccyu'])
  assert.deepEqual(ownersByPattern.get('/python/'), ['@LegGasai'])
  assert.deepEqual(ownersByPattern.get('/website/'), ['@LegGasai'])
  assert.deepEqual(
    rules.filter(rule => rule.owners.includes('@tianyicui')).map(rule => rule.pattern),
    ['/packages/core/', '/packages/session/'],
  )
  for (const excludedOwner of ['@kermeanx', '@pkh-xht']) {
    assert.equal(rules.some(rule => rule.owners.some(owner => owner.toLowerCase() === excludedOwner)), false)
  }
})

test('keeps turtle below one third of the eligible owned codebase', () => {
  const rules = parseOwnership(ownershipSource)
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  let ownedLines = 0
  let turtleLines = 0
  for (const file of trackedFiles) {
    if (isTestPath(file)) continue
    const owners = planReviewers(rules, [file]).matches[0]?.owners ?? []
    if (owners.length === 0) continue
    const content = readFileSync(file)
    const lines = content.length === 0
      ? 0
      : content.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (content.at(-1) === 10 ? 0 : 1)
    ownedLines += lines
    if (owners.includes('@turtle1999')) turtleLines += lines
  }
  assert.ok(
    turtleLines * 3 <= ownedLines,
    `@turtle1999 owns ${turtleLines} of ${ownedLines} eligible owned lines`,
  )
})

test('rejects ownership forms the requester cannot apply safely', () => {
  for (const [source, message] of [
    ['', /contains no rules/u],
    ['* @owner\n', /explicit absolute directory/u],
    ['/.github/ @owner\n', /hidden-directory/u],
    ['/packages/*/ @owner\n', /explicit absolute directory/u],
    ['/packages/core/\n', /at least one owner/u],
    ['/packages/core/ @org/team\n', /individual GitHub users/u],
    ['/packages/core/ @owner @OWNER\n', /duplicate owner/u],
    ['/packages/core/ @owner\n/packages/core/ @other\n', /duplicate pattern/u],
  ]) {
    assert.throws(() => parseOwnership(source), message)
  }
})

test('recognizes every repository test location and filename convention', () => {
  for (const file of [
    'apps/cli/tests/args.spec.ts',
    'apps/cli/tests/harness.ts',
    'apps/web/stress-tests/reasoning-chunks.stress.ts',
    'benchmarks/session-open/workload.ts',
    'native/landlock-run/test/entry.test.js',
    'packages/core/agent/__tests__/agent.ts',
    'packages/core/agent/benches/agent.rs',
    'packages/core/agent/src/agent.compat.spec.ts',
    'packages/core/agent/src/__snapshots__/agent.ts.snap',
    'packages/session-query/session-query/tests/test-service.ts',
    'packages/test-support/session-snapshot/src/index.ts',
    'python/sdk/src/test_client.py',
    'python/sdk/src/client_test.py',
    'scripts/fixtures/translation-prompt/response.txt',
    'scripts/session-snapshot-corpus.corpus.ts',
    'scripts/snapshots/translation-prompt-v4/request-response.expected.json',
    'snapshots/session/headless.snapshot.ts',
  ]) {
    assert.equal(isTestPath(file), true, file)
  }
})

test('does not confuse production names with tests', () => {
  for (const file of [
    'apps/cli/src/testing.ts',
    'packages/core/agent/src/contest.ts',
    'packages/session/session-format/src/snapshot.ts',
    'packages/session/session-format/src/spec.ts',
    'packages/session/session-format/src/test.ts',
    'scripts/run-gates.ts',
    'vitest.config.ts',
    'vitest.bench.config.ts',
    'vitest.e2e.config.ts',
    'vitest.snapshot.config.ts',
    'vitest.web.perf.config.ts',
    'website/docs.ts',
  ]) {
    assert.equal(isTestPath(file), false, file)
  }
})

test('normalizes separators and rejects paths that are not repository-relative', () => {
  assert.equal(normalizeRepositoryPath('./packages\\core\\agent\\src\\index.ts'), 'packages/core/agent/src/index.ts')
  for (const file of ['', '/absolute.ts', '../escape.ts', 'packages//empty.ts', 'packages/./same.ts']) {
    assert.throws(() => normalizeRepositoryPath(file), /path/u, file)
  }
})

test('classifies both sides of a rename independently', () => {
  assert.deepEqual(
    classifyChangedFiles([
      {
        filename: 'packages/core/agent/tests/moved.spec.ts',
        previous_filename: 'packages/core/agent/src/moved.ts',
      },
      {
        filename: 'packages/client/store/src/restored.ts',
        previous_filename: 'packages/client/store/tests/restored.spec.ts',
      },
    ]),
    {
      changedCodeFiles: [
        'packages/client/store/src/restored.ts',
        'packages/core/agent/src/moved.ts',
      ],
      excludedTestFiles: [
        'packages/client/store/tests/restored.spec.ts',
        'packages/core/agent/tests/moved.spec.ts',
      ],
    },
  )
})

test('uses the last matching ownership rule and keeps unmatched files visible', () => {
  const rules = parseOwnership('/packages/ @broad\n/packages/core/ @core @second\n')
  assert.deepEqual(
    planReviewers(rules, ['AGENTS.md', 'packages/core/agent/src/index.ts', 'packages/fs/fs/src/index.ts']),
    {
      matches: [
        { file: 'AGENTS.md', owners: [] },
        { file: 'packages/core/agent/src/index.ts', owners: ['@core', '@second'] },
        { file: 'packages/fs/fs/src/index.ts', owners: ['@broad'] },
      ],
      reviewers: ['broad', 'core', 'second'],
    },
  )
})

test('fetches every declared changed file across pages', async () => {
  const calls = []
  const pageOne = Array.from({ length: 100 }, (_, index) => ({ filename: `packages/core/file-${index}.ts` }))
  const pageTwo = [{ filename: 'packages/core/file-100.ts' }]
  const api = async (path) => {
    calls.push(path)
    return calls.length === 1 ? pageOne : pageTwo
  }
  const files = await listPullRequestFiles(api, 'owner/repo', 42, 101)
  assert.equal(files.length, 101)
  assert.deepEqual(calls, [
    '/repos/owner/repo/pulls/42/files?per_page=100&page=1',
    '/repos/owner/repo/pulls/42/files?per_page=100&page=2',
  ])
})

test('fails closed when GitHub cannot provide the complete file list', async () => {
  let calls = 0
  await assert.rejects(
    listPullRequestFiles(async () => {
      calls++
      return calls === 1 ? [{ filename: 'one.ts' }] : []
    }, 'owner/repo', 42, 2),
    /returned 1 of 2/u,
  )
  await assert.rejects(
    listPullRequestFiles(async () => [], 'owner/repo', 42, 3_001),
    /at most 3000/u,
  )
})

test('prints changed code files before requesting missing owners', async () => {
  const trace = []
  const files = [
    { filename: 'packages/core/agent/src/index.ts' },
    { filename: 'packages/preset/agent-presets/src/index.ts' },
    { filename: 'packages/client/store/src/index.ts' },
    { filename: 'packages/subagent/subagent/src/index.ts' },
    { filename: 'packages/core/agent/tests/index.spec.ts' },
    { filename: 'AGENTS.md' },
  ]
  const api = async (path, options = {}) => {
    trace.push({ type: 'api', path, options })
    if (path.endsWith('/files?per_page=100&page=1')) return files
    if (path.endsWith('/requested_reviewers') && options.method !== 'POST') {
      return { users: [{ login: 'imccyu' }], teams: [] }
    }
    if (path.endsWith('/requested_reviewers') && options.method === 'POST') return {}
    throw new Error(`unexpected API path ${path}`)
  }

  const result = await requestReviews({
    event: pullRequestEvent({ author: 'turtle1999', changedFiles: files.length }),
    ownershipSource,
    api,
    write: line => trace.push({ type: 'log', line }),
  })

  assert.deepEqual(result, {
    changedCodeFiles: [
      'AGENTS.md',
      'packages/client/store/src/index.ts',
      'packages/core/agent/src/index.ts',
      'packages/preset/agent-presets/src/index.ts',
      'packages/subagent/subagent/src/index.ts',
    ],
    excludedTestFiles: ['packages/core/agent/tests/index.spec.ts'],
    requestedReviewers: ['Dudu-0223', 'LegGasai', 'mektpoy', 'tianyicui'],
  })
  assert.equal(trace[0].type, 'log')
  assert.equal(trace[0].line, 'This is by automated Angry Turtle Cyborg, not a human')
  const changedHeading = trace.findIndex(item => item.type === 'log' && item.line === 'Changed code files:')
  const post = trace.findIndex(item => item.type === 'api' && item.options.method === 'POST')
  assert.ok(changedHeading >= 0 && changedHeading < post)
  assert.deepEqual(trace[post], {
    type: 'api',
    path: '/repos/deepseek-harness/deepseek-harness/pulls/42/requested_reviewers',
    options: {
      method: 'POST',
      body: { reviewers: ['Dudu-0223', 'LegGasai', 'mektpoy', 'tianyicui'] },
    },
  })
})

test('does not request reviewers for a test-only change', async () => {
  const calls = []
  const output = []
  const files = [
    { filename: 'apps/web/tests/chat.e2e.ts' },
    { filename: 'packages/core/agent/tests/agent.spec.ts' },
  ]
  const result = await requestReviews({
    event: pullRequestEvent({ changedFiles: files.length }),
    ownershipSource,
    api: async (path) => {
      calls.push(path)
      return files
    },
    write: line => output.push(line),
  })
  assert.deepEqual(result, {
    changedCodeFiles: [],
    excludedTestFiles: files.map(file => file.filename),
    requestedReviewers: [],
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(output.slice(0, 4), [
    'This is by automated Angry Turtle Cyborg, not a human',
    'Changed code files:',
    '- (none)',
    'Excluded test files:',
  ])
})

test('defers draft pull requests without reading changed files', async () => {
  const output = []
  const result = await requestReviews({
    event: pullRequestEvent({ draft: true }),
    ownershipSource,
    api: async () => assert.fail('draft routing must not call GitHub'),
    write: line => output.push(line),
  })
  assert.deepEqual(result, { changedCodeFiles: [], excludedTestFiles: [], requestedReviewers: [] })
  assert.deepEqual(output, [
    'This is by automated Angry Turtle Cyborg, not a human',
    'Draft pull request; reviewer routing is deferred until ready_for_review.',
  ])
})

test('sends authenticated JSON and escapes an API error body', async () => {
  const requests = []
  const api = createGitHubApi({
    token: 'secret',
    apiUrl: 'https://github.example/api/v3/',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  assert.deepEqual(await api('/repos/owner/repo', { method: 'POST', body: { value: 1 } }), { ok: true })
  assert.equal(requests[0].url, 'https://github.example/api/v3/repos/owner/repo')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret')
  assert.equal(requests[0].options.headers['X-GitHub-Api-Version'], '2026-03-10')
  assert.equal(requests[0].options.body, '{"value":1}')

  const failing = createGitHubApi({
    token: 'secret',
    fetchImpl: async () => new Response('::error::untrusted\nbody', { status: 422 }),
  })
  await assert.rejects(failing('/failure'), /"::error::untrusted\\nbody"/u)
})
