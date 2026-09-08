import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createGitHubApi,
  effectiveReviewDecisions,
  evaluateApproval,
  listPullRequestReviews,
  parseApprovalPolicy,
  runApprovalCheck,
} from './check-approval.mjs'

const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')
const HEAD_SHA = '1234567890abcdef1234567890abcdef12345678'

const pullRequestEvent = ({ author = 'author', draft = false } = {}) => ({
  repository: { full_name: 'deepseek-harness/deepseek-harness' },
  pull_request: {
    number: 42,
    draft,
    user: { login: author },
    head: { sha: HEAD_SHA },
  },
})

const review = (login, state) => ({ user: { login }, state })

test('loads the repository approval score policy', () => {
  const policy = parseApprovalPolicy(policySource)
  assert.equal(policy.requiredPoints, 2)
  assert.equal(policy.defaultPoints, 1)
  assert.deepEqual([...policy.reviewerPoints], [
    ['07akioni', 2],
    ['imccyu', 2],
    ['tianyicui', 2],
    ['tianyicui-bot', 2],
    ['turtle1999', 2],
    ['turtle2099', 2],
  ])
})

test('rejects invalid approval score policies', () => {
  for (const [source, message] of [
    ['[]', /must be an object/u],
    ['{"requiredPoints":0,"defaultPoints":1,"reviewerPoints":{}}', /requiredPoints/u],
    ['{"requiredPoints":2,"defaultPoints":0,"reviewerPoints":{}}', /defaultPoints/u],
    ['{"requiredPoints":2,"defaultPoints":1,"reviewerPoints":[]}', /reviewerPoints must be an object/u],
    ['{"requiredPoints":2,"defaultPoints":1,"reviewerPoints":{},"typo":2}', /contain only/u],
    ['{"requiredPoints":2,"defaultPoints":1,"reviewerPoints":{"bad login":2}}', /invalid login/u],
    ['{"requiredPoints":2,"defaultPoints":1,"reviewerPoints":{"User":2,"user":2}}', /duplicate/u],
    ['{"requiredPoints":2,"defaultPoints":1,"reviewerPoints":{"user":-1}}', /positive integer/u],
  ]) {
    assert.throws(() => parseApprovalPolicy(source), message)
  }
})

test('uses each reviewer latest approval or change request while ignoring comments and dismissed reviews', () => {
  assert.deepEqual(effectiveReviewDecisions([
    review('first', 'APPROVED'),
    review('first', 'COMMENTED'),
    review('second', 'CHANGES_REQUESTED'),
    review('second', 'APPROVED'),
    review('third', 'APPROVED'),
    review('third', 'CHANGES_REQUESTED'),
    review('dismissed', 'DISMISSED'),
  ]), [
    { login: 'first', state: 'APPROVED' },
    { login: 'second', state: 'APPROVED' },
    { login: 'third', state: 'CHANGES_REQUESTED' },
  ])
})

test('fetches every pull-request review and rejects an unbounded history', async () => {
  let calls = 0
  const reviews = await listPullRequestReviews(async () => {
    calls++
    return calls === 1 ? Array.from({ length: 100 }, () => review('user', 'COMMENTED')) : []
  }, 'owner/repo', 42)
  assert.equal(reviews.length, 100)
  assert.equal(calls, 2)

  calls = 0
  await assert.rejects(listPullRequestReviews(async () => {
    calls++
    return Array.from({ length: 100 }, () => review('user', 'COMMENTED'))
  }, 'owner/repo', 42), /exceed 3000/u)
  assert.equal(calls, 30)
})

test('accepts one two-point approval from a write-capable reviewer', async () => {
  const calls = []
  const result = await evaluateApproval({
    event: pullRequestEvent(),
    policySource,
    api: async (path) => {
      calls.push(path)
      if (path.includes('/reviews?')) return [review('07akioni', 'APPROVED')]
      if (path.includes('/collaborators/07akioni/permission')) return { permission: 'write' }
      throw new Error(`unexpected API path ${path}`)
    },
  })
  assert.equal(result.state, 'success')
  assert.equal(result.points, 2)
  assert.deepEqual(result.approvals, [{ login: '07akioni', points: 2 }])
  assert.equal(calls.length, 2)
})

test('accepts two one-point approvals and ignores reviews without write access', async () => {
  const result = await evaluateApproval({
    event: pullRequestEvent(),
    policySource,
    api: async (path) => {
      if (path.includes('/reviews?')) {
        return [
          review('reader', 'APPROVED'),
          review('writer-b', 'APPROVED'),
          review('writer-a', 'APPROVED'),
        ]
      }
      if (path.includes('/collaborators/reader/permission')) return { permission: 'read' }
      if (path.includes('/collaborators/writer-a/permission')) return { permission: 'admin' }
      if (path.includes('/collaborators/writer-b/permission')) return { permission: 'write' }
      throw new Error(`unexpected API path ${path}`)
    },
  })
  assert.equal(result.state, 'success')
  assert.equal(result.points, 2)
  assert.deepEqual(result.approvals, [
    { login: 'writer-a', points: 1 },
    { login: 'writer-b', points: 1 },
  ])
  assert.deepEqual(result.ignoredReviewers, ['reader'])
})

test('blocks on a write-capable change request but ignores the author and read-only blockers', async () => {
  const result = await evaluateApproval({
    event: pullRequestEvent({ author: 'author' }),
    policySource,
    api: async (path) => {
      if (path.includes('/reviews?')) {
        return [
          review('turtle1999', 'APPROVED'),
          review('blocker', 'CHANGES_REQUESTED'),
          review('reader', 'CHANGES_REQUESTED'),
          review('author', 'CHANGES_REQUESTED'),
        ]
      }
      if (path.includes('/collaborators/turtle1999/permission')) return { permission: 'admin' }
      if (path.includes('/collaborators/blocker/permission')) return { permission: 'write' }
      if (path.includes('/collaborators/reader/permission')) return { permission: 'read' }
      throw new Error(`unexpected API path ${path}`)
    },
  })
  assert.equal(result.state, 'failure')
  assert.equal(result.points, 2)
  assert.deepEqual(result.blockers, ['blocker'])
  assert.deepEqual(result.ignoredReviewers, ['reader'])
})

test('keeps drafts pending without reading reviews', async () => {
  const result = await evaluateApproval({
    event: pullRequestEvent({ draft: true }),
    policySource,
    api: async () => { throw new Error('draft evaluation must not call GitHub') },
  })
  assert.equal(result.state, 'pending')
  assert.equal(result.points, 0)
  assert.match(result.description, /draft pull request/u)
})

test('publishes the required status and replaces stale success with error on evaluation failure', async () => {
  const calls = []
  const output = []
  const result = await runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    runUrl: 'https://github.example/actions/runs/1',
    api: async (path, options = {}) => {
      calls.push({ path, options })
      if (path.includes('/reviews?')) return [review('turtle2099', 'APPROVED')]
      if (path.includes('/collaborators/turtle2099/permission')) return { permission: 'write' }
      if (path.includes('/statuses/')) return {}
      throw new Error(`unexpected API path ${path}`)
    },
    write: line => output.push(line),
  })
  assert.equal(result.state, 'success')
  assert.deepEqual(calls.at(-1), {
    path: `/repos/deepseek-harness/deepseek-harness/statuses/${HEAD_SHA}`,
    options: {
      method: 'POST',
      body: {
        state: 'success',
        context: 'weighted approval',
        description: 'This is by automated Angry Turtle Cyborg, not a human: 2/2 approval points.',
        target_url: 'https://github.example/actions/runs/1',
      },
    },
  })
  assert.equal(output[0], 'This is by automated Angry Turtle Cyborg, not a human')

  const failures = []
  await assert.rejects(runApprovalCheck({
    event: pullRequestEvent(),
    policySource,
    runUrl: 'https://github.example/actions/runs/2',
    api: async (path, options = {}) => {
      if (path.includes('/reviews?')) throw new Error('reviews unavailable')
      if (path.includes('/statuses/')) {
        failures.push({ path, options })
        return {}
      }
      throw new Error(`unexpected API path ${path}`)
    },
    write: () => {},
  }), /reviews unavailable/u)
  assert.equal(failures[0].options.body.state, 'error')
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
  assert.equal(requests[0].options.body, '{"value":1}')

  const failing = createGitHubApi({
    token: 'secret',
    fetchImpl: async () => new Response('::error::untrusted\nbody', { status: 422 }),
  })
  await assert.rejects(failing('/failure'), /"::error::untrusted\\nbody"/u)
})
