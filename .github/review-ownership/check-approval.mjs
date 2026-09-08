#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const API_VERSION = '2026-03-10'
const MAX_PULL_REQUEST_REVIEWS = 3_000
const PAGE_SIZE = 100
const STATUS_CONTEXT = 'weighted approval'
const STATUS_PREFIX = 'This is by automated Angry Turtle Cyborg, not a human'
const WRITABLE_PERMISSIONS = new Set(['admin', 'write'])
const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'])
const LOGIN = /^[A-Za-z0-9-]+(?:\[bot\])?$/u

/**
 * Parse the approval score policy.
 * @param {string} source Approval policy JSON.
 * @returns {{requiredPoints: number, defaultPoints: number, reviewerPoints: Map<string, number>}} Validated policy.
 */
export function parseApprovalPolicy(source) {
  const value = JSON.parse(source)
  if (!isRecord(value)) throw new Error('approval policy must be an object')
  const fields = Object.keys(value).sort()
  if (fields.join(',') !== 'defaultPoints,requiredPoints,reviewerPoints') {
    throw new Error('approval policy must contain only defaultPoints, requiredPoints, and reviewerPoints')
  }
  const requiredPoints = positiveInteger(value.requiredPoints, 'requiredPoints')
  const defaultPoints = positiveInteger(value.defaultPoints, 'defaultPoints')
  if (!isRecord(value.reviewerPoints)) throw new Error('reviewerPoints must be an object')
  const reviewerPoints = new Map()
  for (const [login, pointsValue] of Object.entries(value.reviewerPoints)) {
    validateLogin(login, 'approval policy reviewer')
    const key = login.toLowerCase()
    if (reviewerPoints.has(key)) throw new Error(`duplicate approval policy reviewer @${login}`)
    reviewerPoints.set(key, positiveInteger(pointsValue, `reviewerPoints.${login}`))
  }
  return { requiredPoints, defaultPoints, reviewerPoints }
}

/**
 * Select each reviewer's latest non-comment review decision.
 * @param {unknown[]} reviews Pull-request review records in GitHub's chronological order.
 * @returns {Array<{login: string, state: 'APPROVED' | 'CHANGES_REQUESTED'}>} Effective review decisions.
 */
export function effectiveReviewDecisions(reviews) {
  const decisions = new Map()
  for (const review of reviews) {
    if (!isRecord(review) || !isRecord(review.user) || typeof review.user.login !== 'string') {
      throw new Error('pull-request review has no reviewer login')
    }
    const login = validateLogin(review.user.login, 'pull-request reviewer')
    if (typeof review.state !== 'string' || !REVIEW_STATES.has(review.state.toUpperCase())) {
      throw new Error(`pull-request review by @${login} has an invalid state`)
    }
    const state = review.state.toUpperCase()
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') {
      decisions.set(login.toLowerCase(), { login, state })
    }
  }
  return [...decisions.values()]
}

/**
 * Create a repository-scoped GitHub JSON API caller.
 * @param {{token: string, apiUrl?: string, fetchImpl?: typeof fetch}} options API dependencies.
 * @returns {(path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>} API caller.
 */
export function createGitHubApi({ token, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('GITHUB_TOKEN is not set')
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  const root = apiUrl.replace(/\/+$/u, '')
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'deepseek-harness-weighted-approval',
        'X-GitHub-Api-Version': API_VERSION,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const responseBody = await response.text()
      throw new Error(`GitHub API ${method} ${path} returned ${response.status}: ${JSON.stringify(responseBody)}`)
    }
    if (response.status === 204) return undefined
    return response.json()
  }
}

/**
 * Fetch every pull-request review or fail before scoring a partial list.
 * @param {(path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>} api GitHub API caller.
 * @param {string} repository Owner/name repository identifier.
 * @param {number} pullNumber Pull-request number.
 * @returns {Promise<unknown[]>} Complete review list within the supported limit.
 */
export async function listPullRequestReviews(api, repository, pullNumber) {
  const reviews = []
  for (let page = 1; ; page++) {
    const response = await api(`/repos/${repository}/pulls/${pullNumber}/reviews?per_page=${PAGE_SIZE}&page=${page}`)
    if (!Array.isArray(response)) throw new Error('pull-request reviews response is not an array')
    reviews.push(...response)
    if (response.length < PAGE_SIZE) return reviews
    if (reviews.length >= MAX_PULL_REQUEST_REVIEWS) {
      throw new Error(`pull-request reviews exceed ${MAX_PULL_REQUEST_REVIEWS} records`)
    }
  }
}

/**
 * Evaluate approval points from current reviews and repository permissions.
 * @param {{event: unknown, policySource: string, api: (path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>}} options Runtime inputs.
 * @returns {Promise<{pull: {repository: string, number: number, headSha: string}, state: 'failure' | 'pending' | 'success', description: string, points: number, requiredPoints: number, approvals: Array<{login: string, points: number}>, blockers: string[], ignoredReviewers: string[]}>} Approval decision and status payload fields.
 */
export async function evaluateApproval({ event, policySource, api }) {
  const pull = pullRequestFromEvent(event)
  const policy = parseApprovalPolicy(policySource)
  if (pull.draft) {
    return approvalResult(pull, policy.requiredPoints, [], [], [], 'pending', 'draft pull request')
  }

  const reviews = await listPullRequestReviews(api, pull.repository, pull.number)
  const decisions = effectiveReviewDecisions(reviews)
    .filter(({ login }) => login.toLowerCase() !== pull.author.toLowerCase())
  const permissions = []
  for (const { login, state } of decisions) {
    permissions.push({ login, state, permission: await reviewerPermission(api, pull.repository, login) })
  }
  const approvals = []
  const blockers = []
  const ignoredReviewers = []
  for (const { login, state, permission } of permissions) {
    if (!WRITABLE_PERMISSIONS.has(permission)) {
      ignoredReviewers.push(login)
    } else if (state === 'CHANGES_REQUESTED') {
      blockers.push(login)
    } else {
      approvals.push({
        login,
        points: policy.reviewerPoints.get(login.toLowerCase()) ?? policy.defaultPoints,
      })
    }
  }
  approvals.sort((left, right) => left.login.localeCompare(right.login, 'en'))
  blockers.sort((left, right) => left.localeCompare(right, 'en'))
  ignoredReviewers.sort((left, right) => left.localeCompare(right, 'en'))
  const points = approvals.reduce((total, approval) => {
    const next = total + approval.points
    if (!Number.isSafeInteger(next)) throw new Error('approval points exceed the safe integer range')
    return next
  }, 0)
  if (blockers.length > 0) {
    return approvalResult(pull, policy.requiredPoints, approvals, blockers, ignoredReviewers, 'failure',
      `${blockers.length} blocking change request${blockers.length === 1 ? '' : 's'}`)
  }
  const state = points >= policy.requiredPoints ? 'success' : 'pending'
  return approvalResult(
    pull,
    policy.requiredPoints,
    approvals,
    blockers,
    ignoredReviewers,
    state,
    `${points}/${policy.requiredPoints} approval points`,
  )
}

/**
 * Evaluate and publish the required commit status, publishing an error status when evaluation fails.
 * @param {{event: unknown, policySource: string, api: (path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>, runUrl: string, write?: (line: string) => void}} options Runtime inputs.
 * @returns {Promise<Awaited<ReturnType<typeof evaluateApproval>>>} Published approval decision.
 */
export async function runApprovalCheck({ event, policySource, api, runUrl, write = line => process.stdout.write(`${line}\n`) }) {
  const pull = pullRequestFromEvent(event)
  write(STATUS_PREFIX)
  let result
  try {
    result = await evaluateApproval({ event, policySource, api })
  } catch (error) {
    await publishStatus(api, pull, 'error', `${STATUS_PREFIX}: approval evaluation failed.`, runUrl)
    throw error
  }
  write(`Approval score: ${result.points}/${result.requiredPoints}.`)
  writeList(write, 'Counted approvals', result.approvals.map(({ login, points }) => `@${login}: ${points}`))
  writeList(write, 'Blocking change requests', result.blockers.map(login => `@${login}`))
  writeList(write, 'Ignored reviewers without write access', result.ignoredReviewers.map(login => `@${login}`))
  await publishStatus(api, pull, result.state, result.description, runUrl)
  write(`Published ${JSON.stringify(STATUS_CONTEXT)} status ${JSON.stringify(result.state)}.`)
  return result
}

function approvalResult(pull, requiredPoints, approvals, blockers, ignoredReviewers, state, detail) {
  return {
    pull: { repository: pull.repository, number: pull.number, headSha: pull.headSha },
    state,
    description: `${STATUS_PREFIX}: ${detail}.`,
    points: approvals.reduce((total, approval) => total + approval.points, 0),
    requiredPoints,
    approvals,
    blockers,
    ignoredReviewers,
  }
}

async function reviewerPermission(api, repository, login) {
  const response = await api(`/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`)
  if (!isRecord(response) || typeof response.permission !== 'string') {
    throw new Error(`collaborator permission response for @${login} has no permission`)
  }
  return response.permission.toLowerCase()
}

async function publishStatus(api, pull, state, description, runUrl) {
  if (!/^https:\/\/[^\s]+$/u.test(runUrl)) throw new Error('workflow run URL must use HTTPS')
  if (description.length > 140) throw new Error('commit status description exceeds 140 characters')
  await api(`/repos/${pull.repository}/statuses/${pull.headSha}`, {
    method: 'POST',
    body: {
      state,
      context: STATUS_CONTEXT,
      description,
      target_url: runUrl,
    },
  })
}

function pullRequestFromEvent(event) {
  if (!isRecord(event) || !isRecord(event.repository) || typeof event.repository.full_name !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(event.repository.full_name)) {
    throw new Error('event has no valid repository.full_name')
  }
  if (!isRecord(event.pull_request) || !isRecord(event.pull_request.user)
    || !isRecord(event.pull_request.head)) {
    throw new Error('event has no pull_request')
  }
  const pull = event.pull_request
  if (!Number.isSafeInteger(pull.number) || pull.number <= 0) throw new Error('pull request has no valid number')
  if (typeof pull.draft !== 'boolean') throw new Error('pull request has no draft flag')
  const author = validateLogin(pull.user.login, 'pull-request author')
  if (typeof pull.head.sha !== 'string' || !/^[0-9a-f]{40}$/u.test(pull.head.sha)) {
    throw new Error('pull request has no valid head SHA')
  }
  return {
    repository: event.repository.full_name,
    number: pull.number,
    draft: pull.draft,
    author,
    headSha: pull.head.sha,
  }
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`)
  return value
}

function validateLogin(value, subject) {
  if (typeof value !== 'string' || !LOGIN.test(value)) throw new Error(`${subject} has an invalid login`)
  return value
}

function writeList(write, title, entries) {
  write(`${title}:`)
  if (entries.length === 0) write('- (none)')
  else for (const entry of entries) write(`- ${entry}`)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set')
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')
  const api = createGitHubApi({
    token: process.env.GITHUB_TOKEN ?? '',
    apiUrl: process.env.GITHUB_API_URL,
  })
  await runApprovalCheck({
    event,
    policySource,
    api,
    runUrl: process.env.GITHUB_RUN_URL ?? '',
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`weighted approval failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
