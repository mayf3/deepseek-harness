#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { productionOwnership, LOGIN } from './blame-ownership.mjs'
import { authorCreditPoints, countMergedAuthorPulls } from './author-weight.mjs'

const API_VERSION = '2026-03-10'
const MAX_PULL_REQUEST_RECORDS = 3_000
const PAGE_SIZE = 100
const STATUS_CONTEXT = 'weighted approval'
const WRITABLE_PERMISSIONS = new Set(['admin', 'write'])
const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'])

class GitHubApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
  }
}

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
 * Select each reviewer's current approval or change-request decision.
 * @param {unknown[]} reviews Pull-request review records in GitHub's chronological order.
 * @returns {Array<{login: string, state: 'APPROVED' | 'CHANGES_REQUESTED'}>} Effective review decisions.
 */
export function effectiveReviewDecisions(reviews) {
  const decisions = new Map()
  for (const review of reviews) {
    if (!isRecord(review)) throw new Error('pull-request review is not an object')
    if (review.user === null) continue
    if (!isRecord(review.user) || typeof review.user.login !== 'string') {
      throw new Error('pull-request review has no reviewer login')
    }
    const login = validateLogin(review.user.login, 'pull-request reviewer')
    if (typeof review.state !== 'string' || !REVIEW_STATES.has(review.state.toUpperCase())) {
      throw new Error(`pull-request review by @${login} has an invalid state`)
    }
    const state = review.state.toUpperCase()
    const key = login.toLowerCase()
    if (state === 'DISMISSED') {
      decisions.delete(key)
    } else if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') {
      decisions.set(key, { login, state })
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
      throw new GitHubApiError(
        `GitHub API ${method} ${path} returned ${response.status}: ${JSON.stringify(responseBody)}`,
        response.status,
      )
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
  return listRecords(api, `/repos/${repository}/pulls/${pullNumber}/reviews`, 'pull-request reviews')
}

async function listRecords(api, path, subject) {
  const records = []
  for (let page = 1; ; page++) {
    const response = await api(`${path}?per_page=${PAGE_SIZE}&page=${page}`)
    if (!Array.isArray(response)) throw new Error(`${subject} response is not an array`)
    records.push(...response)
    if (response.length < PAGE_SIZE) return records
    if (records.length >= MAX_PULL_REQUEST_RECORDS) {
      throw new Error(`${subject} exceed ${MAX_PULL_REQUEST_RECORDS} records`)
    }
  }
}

// The API orders comments by creation ID; edits do not reorder commands.
function effectiveDelegations(comments, reviews) {
  const delegations = new Map()
  for (const comment of comments) {
    if (!isRecord(comment)) throw new Error('pull-request comment is not an object')
    if (comment.user === null) continue
    if (typeof comment.body !== 'string') throw new Error('pull-request comment has no body')
    const match = /^\/delegate @([^\s]+)$/u.exec(comment.body.trim())
    if (!match || !LOGIN.test(match[1])) continue
    const login = validateLogin(comment.user?.login, 'delegation author').toLowerCase()
    const delegate = match[1].toLowerCase()
    if (login === delegate) delegations.delete(login)
    else {
      if (!Number.isSafeInteger(comment.id) || comment.id <= 0) throw new Error('delegation comment has no valid ID')
      delegations.set(login, { delegate, commentId: comment.id, createdAt: timestamp(comment.created_at, 'delegation comment') })
    }
  }
  for (const review of reviews) {
    if (review.user === null || review.state.toUpperCase() === 'PENDING') continue
    const login = review.user.login.toLowerCase()
    const delegation = delegations.get(login)
    if (delegation && timestamp(review.submitted_at, 'submitted review') >= delegation.createdAt) {
      delegations.delete(login)
    }
  }
  return delegations
}

function timestamp(value, subject) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(time)) throw new Error(`${subject} has no valid timestamp`)
  return time
}

/**
 * Evaluate approval points from current reviews and repository permissions.
 * @param {{event: unknown, policySource: string, api: (path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>, getOwnership?: typeof productionOwnership, getMergedCount?: typeof countMergedAuthorPulls}} options Runtime inputs.
 * @returns {Promise<{pull: {repository: string, number: number, headSha: string}, state: 'pending' | 'success', description: string, points: number, authorCredit: {mergedCount: number, points: number} | null, requiredPoints: number, approvals: Array<{login: string, points: number, delegatedTo?: string, ownership?: {ownedLines: number, totalLines: number}}>, delegations: Array<{login: string, delegatedTo: string, commentId: number}>, blockers: string[], ignoredReviewers: string[]}>} Approval decision and status payload fields; approval login owns the points, delegatedTo supplies its decision, delegations contains eligible active commands, and null author credit means history was not evaluated.
 */
export async function evaluateApproval({ event, policySource, api, getOwnership = productionOwnership, getMergedCount = countMergedAuthorPulls }) {
  const pull = pullRequestFromEvent(event)
  const policy = parseApprovalPolicy(policySource)
  if (pull.draft) {
    return approvalResult(pull, policy.requiredPoints, [], [], [], 'pending', 'draft pull request')
  }

  const reviews = await listPullRequestReviews(api, pull.repository, pull.number)
  const decisions = effectiveReviewDecisions(reviews)
    .filter(({ login }) => login.toLowerCase() !== pull.author.toLowerCase())
  const comments = await listRecords(api, `/repos/${pull.repository}/issues/${pull.number}/comments`, 'pull-request comments')
  const delegations = effectiveDelegations(comments, reviews)
  const participants = new Map(decisions.map(({ login }) => [login.toLowerCase(), login]))
  for (const [login, { delegate }] of delegations) {
    participants.set(login, participants.get(login) ?? login)
    participants.set(delegate, participants.get(delegate) ?? delegate)
  }
  participants.delete(pull.author.toLowerCase())
  const writers = new Set()
  const ignoredReviewers = []
  for (const [key, login] of participants) {
    const permission = await reviewerPermission(api, pull.repository, login)
    if (WRITABLE_PERMISSIONS.has(permission)) writers.add(key)
    else ignoredReviewers.push(login)
  }
  const approvals = []
  const activeDelegations = []
  const blockers = decisions.filter(({ login, state }) => writers.has(login.toLowerCase()) && state === 'CHANGES_REQUESTED')
    .map(({ login }) => login)
  const approved = new Set(decisions.filter(({ state }) => state === 'APPROVED').map(({ login }) => login.toLowerCase()))
  for (const key of writers) {
    const delegation = delegations.get(key)
    const target = delegation?.delegate
    const delegatedTo = writers.has(target) ? target : undefined
    if (delegatedTo) activeDelegations.push({
      login: participants.get(key), delegatedTo: participants.get(delegatedTo), commentId: delegation.commentId,
    })
    if (!approved.has(delegatedTo ?? key)) continue
    approvals.push({
      login: participants.get(key),
      points: policy.reviewerPoints.get(key) ?? policy.defaultPoints,
      ...(delegatedTo ? { delegatedTo: participants.get(delegatedTo) } : {}),
    })
  }
  let authorCredit = null
  const reviewerPoints = approvals.reduce((sum, approval) => sum + approval.points, 0)
  if (blockers.length === 0 && reviewerPoints < policy.requiredPoints) {
    const mergedCount = await getMergedCount(pull, api)
    authorCredit = { mergedCount, points: authorCreditPoints(mergedCount) }
  }
  const pointsBeforeOwnership = reviewerPoints + (authorCredit?.points ?? 0)
  if (blockers.length === 0 && pointsBeforeOwnership < policy.requiredPoints
    && approvals.some(approval => approval.points === policy.defaultPoints)) {
    const ownership = await getOwnership(pull, api)
    for (const approval of approvals) {
      if (approval.points !== policy.defaultPoints) continue
      const ownedLines = ownership.reviewerLines[approval.login.toLowerCase()] ?? 0
      approval.ownership = { ownedLines, totalLines: ownership.totalLines }
      if (ownership.totalLines > 0) approval.points = Math.min(policy.requiredPoints, policy.defaultPoints
        + (policy.requiredPoints - policy.defaultPoints) * 4 * ownedLines / ownership.totalLines)
    }
  }
  approvals.sort((left, right) => left.login.localeCompare(right.login, 'en'))
  blockers.sort((left, right) => left.localeCompare(right, 'en'))
  ignoredReviewers.sort((left, right) => left.localeCompare(right, 'en'))
  const points = approvals.reduce((total, approval) => {
    const next = total + approval.points
    if (!Number.isFinite(next) || next > Number.MAX_SAFE_INTEGER) throw new Error('approval points must be finite and at most Number.MAX_SAFE_INTEGER')
    return next
  }, authorCredit?.points ?? 0)
  if (blockers.length > 0) {
    return approvalResult(pull, policy.requiredPoints, approvals, blockers, ignoredReviewers, 'pending',
      `${blockers.length} blocking change request${blockers.length === 1 ? '' : 's'}`, authorCredit, activeDelegations)
  }
  // Tolerate floating-point addition error without rounding approval scores.
  const state = points + 1e-12 >= policy.requiredPoints ? 'success' : 'pending'
  return approvalResult(
    pull,
    policy.requiredPoints,
    approvals,
    blockers,
    ignoredReviewers,
    state,
    `${Number(points.toFixed(3))}/${policy.requiredPoints} approval points${authorCredit ? ` (author ${authorCredit.points})` : ''}`,
    authorCredit,
    activeDelegations,
  )
}

/**
 * Evaluate and publish the required commit status, publishing an error status when evaluation fails.
 * @param {{event: unknown, policySource: string, api: (path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>, runUrl: string, write?: (line: string) => void, getOwnership?: typeof productionOwnership, getMergedCount?: typeof countMergedAuthorPulls}} options Runtime inputs.
 * @returns {Promise<Awaited<ReturnType<typeof evaluateApproval>>>} Published approval decision.
 */
export async function runApprovalCheck({ event, policySource, api, runUrl, getOwnership = productionOwnership, getMergedCount = countMergedAuthorPulls, write = line => process.stdout.write(`${line}\n`) }) {
  const pull = pullRequestFromEvent(event)
  await publishStatus(api, pull, 'pending', 'Evaluating approval points.', runUrl)
  let result
  try {
    result = await evaluateApproval({ event, policySource, api, getOwnership, getMergedCount })
    await requestDelegatedReview(event, result, api, write)
  } catch (error) {
    await publishStatus(api, pull, 'error', 'Approval evaluation failed.', runUrl)
    throw error
  }
  write(result.authorCredit
    ? `Author credit: ${result.authorCredit.points} (${result.authorCredit.mergedCount} merged PRs).`
    : `Author credit: not evaluated (${pull.draft ? 'draft' : result.blockers.length ? 'blocking review' : 'reviewer points suffice'}).`)
  write(`Approval score: ${result.points}/${result.requiredPoints}.`)
  writeList(write, 'Counted approvals', result.approvals.map(({ login, points, ownership, delegatedTo }) =>
    `@${login}: ${points}${delegatedTo ? ` (delegated to @${delegatedTo})` : ''}${ownership ? ` (${ownership.ownedLines}/${ownership.totalLines} old production lines)` : ''}`))
  writeList(write, 'Blocking change requests', result.blockers.map(login => `@${login}`))
  writeList(write, 'Ignored reviewers without write access', result.ignoredReviewers.map(login => `@${login}`))
  await publishStatus(api, pull, result.state, result.description, runUrl)
  write(`Published ${JSON.stringify(STATUS_CONTEXT)} status ${JSON.stringify(result.state)}.`)
  return result
}

/**
 * Revoke a previous success before dependency installation, or report its failure.
 * @param {{event: unknown, api: (path: string, options: object) => Promise<unknown>, runUrl: string, phase: string}} options Publication inputs.
 * @returns {Promise<void>} Completion of the status write.
 */
export async function publishApprovalPhase({ event, api, runUrl, phase }) {
  if (!['pending', 'error'].includes(phase)) throw new Error('invalid approval setup phase')
  await publishStatus(api, pullRequestFromEvent(event), phase,
    phase === 'pending' ? 'Preparing approval evaluation.' : 'Approval setup or evaluation failed.', runUrl)
}

/**
 * Resolve the reviewed pull request from a completed run of the review-event workflow file.
 * @param {{event: unknown, api: (path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>}} options Trusted workflow inputs.
 * @returns {Promise<Record<string, unknown> | null>} Event with a current pull request, or null after the pull-request head changes.
 */
export async function approvalEventFromWorkflowRun({ event, api }) {
  const repository = repositoryFromEvent(event)
  // GitHub can expand run-name into name; the file path identifies the source workflow.
  if (!isRecord(event.workflow_run)
    || event.workflow_run.path !== '.github/workflows/weighted-approval-review-event.yml'
    || event.workflow_run.event !== 'pull_request_review' || event.workflow_run.conclusion !== 'success') {
    throw new Error('event has no successful weighted approval review workflow run')
  }
  const expectedHeadSha = validateHeadSha(event.workflow_run.head_sha, 'workflow run')
  const pullNumber = parsePullNumber(event.workflow_run.display_title)
  if (!Array.isArray(event.workflow_run.pull_requests)) {
    throw new Error('workflow run has no pull_requests array')
  }
  if (event.workflow_run.pull_requests.length > 0
    && !event.workflow_run.pull_requests.some(pull => isRecord(pull) && pull.number === pullNumber)) {
    throw new Error(`workflow run is not associated with pull request #${pullNumber}`)
  }
  const pull = await api(`/repos/${repository}/pulls/${pullNumber}`)
  if (!isRecord(pull) || !isRecord(pull.head)) throw new Error(`pull request #${pullNumber} response is invalid`)
  if (pull.head.sha !== expectedHeadSha) return null
  return { ...event, pull_request: pull }
}

/**
 * Resolve a PR conversation comment to the current pull request; ordinary issues are skipped.
 * @param {{event: unknown, api: (path: string) => Promise<unknown>}} options Comment event and API caller.
 * @returns {Promise<Record<string, unknown> | null>} Current PR event, or null for an issue or closed PR.
 */
export async function approvalEventFromComment({ event, api }) {
  const repository = repositoryFromEvent(event)
  if (!isRecord(event.issue)) throw new Error('comment event has no issue')
  if (!isRecord(event.issue.pull_request)) return null
  const number = event.issue.number
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('comment event has no valid pull-request number')
  const pull = await api(`/repos/${repository}/pulls/${number}`)
  if (!isRecord(pull) || pull.number !== number || !['open', 'closed'].includes(pull.state)) {
    throw new Error('comment pull-request response is invalid')
  }
  if (pull.state === 'closed') return null
  const resolved = { ...event, pull_request: pull }
  pullRequestFromEvent(resolved)
  return resolved
}

async function requestDelegatedReview(event, result, api, write) {
  if (!isRecord(event.issue) || !['created', 'edited'].includes(event.action) || !isRecord(event.comment)) return
  const delegation = result.delegations.find(({ commentId }) => commentId === event.comment.id)
  if (!delegation) return
  const path = `/repos/${result.pull.repository}/pulls/${result.pull.number}/requested_reviewers`
  const requested = await api(path)
  if (!isRecord(requested) || !Array.isArray(requested.users)) throw new Error('requested reviewers response has no users array')
  const logins = requested.users.map(user => validateLogin(user?.login, 'requested reviewer').toLowerCase())
  if (logins.includes(delegation.delegatedTo.toLowerCase())) return
  await api(path, { method: 'POST', body: { reviewers: [delegation.delegatedTo] } })
  write(`Requested review from @${delegation.delegatedTo} for @${delegation.login}'s delegation.`)
}

function approvalResult(pull, requiredPoints, approvals, blockers, ignoredReviewers, state, detail, authorCredit = null, delegations = []) {
  return {
    pull: { repository: pull.repository, number: pull.number, headSha: pull.headSha },
    state,
    description: `${detail}.`,
    points: approvals.reduce((total, approval) => total + approval.points, authorCredit?.points ?? 0),
    authorCredit,
    requiredPoints,
    approvals,
    delegations,
    blockers,
    ignoredReviewers,
  }
}

async function reviewerPermission(api, repository, login) {
  let response
  try {
    response = await api(`/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`)
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return 'none'
    throw error
  }
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
  const repository = repositoryFromEvent(event)
  if (!isRecord(event.pull_request) || !isRecord(event.pull_request.user)
    || !isRecord(event.pull_request.head)) {
    throw new Error('event has no pull_request')
  }
  const pull = event.pull_request
  if (!Number.isSafeInteger(pull.number) || pull.number <= 0) throw new Error('pull request has no valid number')
  if (typeof pull.draft !== 'boolean') throw new Error('pull request has no draft flag')
  const author = validateLogin(pull.user.login, 'pull-request author')
  // REST node_id and GraphQL id identify the same global account node.
  if (typeof pull.user.node_id !== 'string' || !pull.user.node_id) throw new Error('pull request has no author account ID')
  const headSha = validateHeadSha(pull.head.sha, 'pull request')
  return {
    repository,
    number: pull.number,
    draft: pull.draft,
    author,
    authorId: pull.user.node_id,
    headSha,
  }
}

function repositoryFromEvent(event) {
  if (!isRecord(event) || !isRecord(event.repository) || typeof event.repository.full_name !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(event.repository.full_name)) {
    throw new Error('event has no valid repository.full_name')
  }
  return event.repository.full_name
}

function validateHeadSha(value, subject) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${subject} has no valid head SHA`)
  }
  return value
}

function parsePullNumber(source) {
  if (typeof source !== 'string') throw new Error('review event has no valid run title')
  const match = /^weighted-approval-review-event:([1-9][0-9]*)$/u.exec(source)
  if (!match) throw new Error('review event has no valid run title')
  const pullNumber = Number(match[1])
  if (!Number.isSafeInteger(pullNumber)) throw new Error('review event pull request number is not a safe integer')
  return pullNumber
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
  let event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')
  const api = createGitHubApi({
    token: process.env.GITHUB_TOKEN ?? '',
    apiUrl: process.env.GITHUB_API_URL,
  })
  if (isRecord(event) && isRecord(event.issue)) {
    event = await approvalEventFromComment({ event, api })
    if (event === null) return
  }
  if (isRecord(event) && isRecord(event.workflow_run)) {
    const resolved = await approvalEventFromWorkflowRun({
      event,
      api,
    })
    if (resolved === null) {
      process.stdout.write('Skipped a review event for a superseded pull-request head.\n')
      return
    }
    event = resolved
  }
  const phase = process.argv[2]
  if (phase) {
    await publishApprovalPhase({ event, api, runUrl: process.env.GITHUB_RUN_URL ?? '', phase })
    return
  }
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
