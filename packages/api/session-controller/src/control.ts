/** Live Session control state, interaction waits, and reconnect baselines. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type {
  JsonValue, Session, SessionEvent, SessionEventMap, SessionId, UserMessage,
} from '@deepseek-ai/dsh-session'
import type {
  ApprovalOutcome, ApprovalRequestEvent, ApprovalRequestId,
} from '@deepseek-ai/dsh-user-approval/types'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type {
  SessionApprovalRequest,
  SessionApprovalResponse,
  SessionControlBaseline,
  SessionControlFrame,
  SessionInteractionId,
  SessionJob,
  SessionProjectionsBlock,
  SessionProjectionValues,
  SessionQuestionRequest,
  SessionQuestionResponse,
  SessionQueuedItem,
  SessionRespondReceipt,
  SessionRespondRequest,
} from './types.ts'

interface PendingApproval extends SessionApprovalRequest {
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
  settle(outcome: ApprovalOutcome): void
}

interface PendingQuestion extends SessionQuestionRequest {
  readonly questions: AskUserQuestionItem[]
  readonly signal?: AbortSignal
  onAbort?: () => void
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: UserQuestionError): void
}

/** Owns the Host-wide control stream and answerable interaction registry. */
export class SessionControlController {
  private readonly streams = new Set<ControlQueue>()
  private readonly approvals = new Map<SessionInteractionId, PendingApproval>()
  private readonly questions = new Map<SessionInteractionId, PendingQuestion>()

  /** @param ctx - Host context carrying live Agent, projection, jobs, approval, and question services. */
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })
    ctx.on('session/created', (session) => {
      const jobs = this.jobsFor(this.ctx.agents.get(session.id))
      if (jobs.length > 0) this.broadcast({ type: 'jobs', sessionId: session.id, jobs })
    })
    ctx.on('session/disposed', (session) => { this.cancelSessionInteractions(session.id) })

    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.onChanged((session, key, value, seq) => {
        this.broadcast({
          type: 'projection',
          sessionId: session.id,
          key,
          value: value as JsonValue,
          seq,
        })
      })
    })
    ctx.inject(['jobs'], (jobsCtx) => {
      jobsCtx.jobs.onJobsChanged((owner) => { this.onJobsChanged(owner) })
    })
    ctx.inject(['approval'], (approvalCtx) => {
      approvalCtx.on('approval/request', (request, next) => this.requestApproval(request, next))
    })

    const disposeQuestions = ctx.userQuestions.registerProvider({
      ask: request => this.requestQuestion(request),
    })
    ctx.effect(() => () => {
      disposeQuestions()
      for (const pending of [...this.questions.values()]) {
        this.claimQuestion(pending, 'cancelled')
        pending.reject(new UserQuestionError(
          'Session Controller user-questions provider was disposed',
          'ASK_ABORTED',
        ))
      }
      for (const pending of [...this.approvals.values()]) pending.settle('cancelled')
      for (const stream of this.streams) stream.end()
      this.streams.clear()
    }, 'session-controller.control')
  }

  /**
   * Open one generation of Host-wide live control state.
   * @param signal - Remote stream cancellation.
   * @returns one complete baseline followed by live replacement frames.
   */
  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    signal.throwIfAborted()
    const queue = new ControlQueue()
    this.streams.add(queue)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* queue.iterate(signal)
    } finally {
      this.streams.delete(queue)
      queue.end()
    }
  }

  /**
   * Settle one still-pending approval or question.
   * @param request - interaction identity and caller response.
   * @returns whether a matching pending interaction accepted the response.
   */
  respond(request: SessionRespondRequest): SessionRespondReceipt {
    const approval = this.approvals.get(request.interactionId)
    if (approval !== undefined) return this.respondApproval(approval, request)
    const question = this.questions.get(request.interactionId)
    if (question !== undefined) return this.respondQuestion(question, request)
    return { accepted: false, reason: 'not-pending' }
  }

  private baseline(): SessionControlBaseline {
    const sessions = this.ctx.sessions.list()
    const queues = Object.create(null) as Record<SessionId, readonly SessionQueuedItem[]>
    const jobs = Object.create(null) as Record<SessionId, readonly SessionJob[]>
    for (const session of sessions) {
      const agent = this.ctx.agents.get(session.id)
      queues[session.id] = agent?.session === session ? queueItems(agent) : []
      jobs[session.id] = this.jobsFor(agent)
    }
    return {
      queues,
      jobs,
      approvals: [...this.approvals.values()].map(pending => approvalRequest(pending)),
      questions: [...this.questions.values()].map(pending => questionRequest(pending)),
      projections: this.projectionBaseline(sessions),
    }
  }

  private projectionBaseline(
    sessions: readonly Session[],
  ): Readonly<Record<SessionId, SessionProjectionsBlock>> {
    const registry = this.ctx.get('sessionProjections')
    const blocks = Object.create(null) as Record<SessionId, SessionProjectionsBlock>
    for (const session of sessions) {
      const snapshot = registry?.snapshot(session)
      blocks[session.id] = snapshot === undefined
        ? { asOfSeq: session.seq - 1, values: {} }
        : {
          asOfSeq: snapshot.asOfSeq,
          // Every projection definition validates its value before snapshot publication.
          values: snapshot.values as SessionProjectionValues,
        }
    }
    return blocks
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'agent/inbox/spliced') return
    const agent = this.ctx.agents.get(session.id)
    if (agent?.session !== session) return
    this.broadcast({
      type: 'queue',
      sessionId: session.id,
      items: queueItems(agent, event.data),
    })
  }

  private onJobsChanged(owner: Agent | undefined): void {
    if (owner !== undefined) {
      this.broadcast({ type: 'jobs', sessionId: owner.id, jobs: this.jobsFor(owner) })
      return
    }
    for (const session of this.ctx.sessions.list()) {
      this.broadcast({
        type: 'jobs',
        sessionId: session.id,
        jobs: this.jobsFor(this.ctx.agents.get(session.id)),
      })
    }
  }

  private jobsFor(agent: Agent | undefined): SessionJob[] {
    const jobs = this.ctx.get('jobs')
    return jobs === undefined ? [] : jobs.list(agent).map(jobView)
  }

  private requestQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const sessionId = request.agent?.id
    if (sessionId === undefined) {
      return Promise.reject(new UserQuestionError(
        'web user interaction requires an agent-owned session',
        'ASK_MISSING_AGENT',
      ))
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(new UserQuestionError(
        'ask_user_question was aborted before the user answered',
        'ASK_ABORTED',
      ))
    }
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const interactionId = newInteractionId()
      const pending: PendingQuestion = {
        interactionId,
        sessionId,
        questions: request.questions,
        resolve,
        reject,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
      const onAbort = (): void => {
        if (!this.claimQuestion(pending, 'cancelled')) return
        reject(new UserQuestionError(
          'ask_user_question was aborted before the user answered',
          'ASK_ABORTED',
        ))
      }
      pending.onAbort = onAbort
      this.questions.set(interactionId, pending)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted === true) {
        onAbort()
        return
      }
      this.broadcast({ type: 'question/requested', ...questionRequest(pending) })
    })
  }

  private requestApproval(
    request: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (request.signal?.aborted === true) return Promise.resolve('cancelled')
    const approvalId = findApprovalId(request, this.approvals.values())
    if (approvalId === undefined) return next()
    return new Promise<ApprovalOutcome>((resolve) => {
      const interactionId = newInteractionId()
      const pending: PendingApproval = {
        interactionId,
        sessionId: request.agent.session.id,
        approvalId,
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        settle: (outcome) => {
          if (this.approvals.get(interactionId) !== pending) return
          this.approvals.delete(interactionId)
          request.signal?.removeEventListener('abort', onAbort)
          this.broadcast({
            type: 'approval/resolved',
            interactionId,
            sessionId: pending.sessionId,
            approvalId,
            outcome,
          })
          resolve(outcome)
        },
      }
      const onAbort = (): void => { pending.settle('cancelled') }
      Object.assign(pending, { onAbort })
      this.approvals.set(interactionId, pending)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted === true) {
        pending.settle('cancelled')
        return
      }
      this.broadcast({ type: 'approval/requested', ...approvalRequest(pending) })
    })
  }

  private respondApproval(
    pending: PendingApproval,
    request: SessionRespondRequest,
  ): SessionRespondReceipt {
    if (!request.result.ok) return { accepted: false, reason: 'bad-response' }
    const response = approvalResponse(request.result.value)
    if (response === undefined
      || response.sessionId !== pending.sessionId
      || response.approvalId !== pending.approvalId) {
      return { accepted: false, reason: 'bad-response' }
    }
    pending.settle(response.outcome)
    return { accepted: true }
  }

  private respondQuestion(
    pending: PendingQuestion,
    request: SessionRespondRequest,
  ): SessionRespondReceipt {
    if (!request.result.ok) {
      if (request.result.error.code !== 'cancelled') return { accepted: false, reason: 'bad-response' }
      if (!this.claimQuestion(pending, 'cancelled')) return { accepted: false, reason: 'not-pending' }
      pending.reject(new UserQuestionError(
        'the user cancelled ask_user_question',
        'ASK_CANCELLED',
      ))
      return { accepted: true }
    }
    const response = questionResponse(request.result.value)
    if (response === undefined
      || response.sessionId !== pending.sessionId
      || !matchesQuestions(response.answer, pending.questions)) {
      return { accepted: false, reason: 'bad-response' }
    }
    if (!this.claimQuestion(pending, 'answered')) return { accepted: false, reason: 'not-pending' }
    pending.resolve(response.answer)
    return { accepted: true }
  }

  private claimQuestion(
    pending: PendingQuestion,
    outcome: 'answered' | 'cancelled',
  ): boolean {
    if (this.questions.get(pending.interactionId) !== pending) return false
    this.questions.delete(pending.interactionId)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    this.broadcast({
      type: 'question/resolved',
      interactionId: pending.interactionId,
      sessionId: pending.sessionId,
      outcome,
    })
    return true
  }

  private cancelSessionInteractions(sessionId: SessionId): void {
    for (const pending of [...this.approvals.values()]) {
      if (pending.sessionId === sessionId) pending.settle('cancelled')
    }
    for (const pending of [...this.questions.values()]) {
      if (pending.sessionId !== sessionId || !this.claimQuestion(pending, 'cancelled')) continue
      pending.reject(new UserQuestionError(
        'the owning session was disposed before the user answered',
        'ASK_ABORTED',
      ))
    }
  }

  private broadcast(frame: SessionControlFrame): void {
    for (const stream of this.streams) stream.push(frame)
  }
}

class ControlQueue {
  private readonly buffer: SessionControlFrame[] = []
  private wake: (() => void) | undefined
  private done = false

  push(frame: SessionControlFrame): void {
    if (this.done) return
    this.buffer.push(frame)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  end(): void {
    if (this.done) return
    this.done = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        const frame = this.buffer.shift()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      while (this.buffer.length > 0 && !signal.aborted) yield this.buffer.shift() as SessionControlFrame
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.end()
    }
  }
}

function newInteractionId(): SessionInteractionId {
  return randomUUID() as SessionInteractionId
}

function approvalRequest(pending: PendingApproval): SessionApprovalRequest {
  return {
    interactionId: pending.interactionId,
    sessionId: pending.sessionId,
    approvalId: pending.approvalId,
    toolName: pending.toolName,
    ...(pending.callId === undefined ? {} : { callId: pending.callId }),
    ...(pending.reason === undefined ? {} : { reason: pending.reason }),
  }
}

function questionRequest(pending: PendingQuestion): SessionQuestionRequest {
  return {
    interactionId: pending.interactionId,
    sessionId: pending.sessionId,
    questions: pending.questions,
  }
}

function queueItems(
  agent: Agent,
  splice?: SessionEventMap['agent/inbox/spliced'],
): SessionQueuedItem[] {
  const project = (target: 'next-turn' | 'next-step'): readonly UserMessage[] => {
    const messages = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
    return splice?.target === target
      ? messages.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      : messages
  }
  return [
    ...project('next-turn').map(message => ({
      id: message.id,
      placement: 'queued' as const,
      message: { id: message.id, content: message.content as unknown as JsonValue[] },
    })),
    ...project('next-step').map(message => ({
      id: message.id,
      placement: message.source.kind === 'user' ? 'steering' as const : 'context' as const,
      message: { id: message.id, content: message.content as unknown as JsonValue[] },
    })),
  ]
}

function jobView(job: JobSnapshot): SessionJob {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...(job.detail === undefined ? {} : { detail: job.detail }),
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
  }
}

function findApprovalId(
  request: ApprovalRequestEvent,
  pending: Iterable<PendingApproval>,
): ApprovalRequestId | undefined {
  const claimed = new Set<ApprovalRequestId>()
  for (const entry of pending) claimed.add(entry.approvalId)
  const decided = new Set<ApprovalRequestId>()
  const events = request.agent.session.events
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as SessionEvent
    if (event.type === 'approval/decided') {
      decided.add(event.data.id)
      continue
    }
    if (event.type !== 'approval/asked'
      || decided.has(event.data.id)
      || claimed.has(event.data.id)
      || (request.callId ?? null) !== (event.data.callId ?? null)) continue
    return event.data.id
  }
  return undefined
}

function approvalResponse(value: unknown): SessionApprovalResponse | undefined {
  if (!isRecord(value)
    || typeof value.sessionId !== 'string'
    || typeof value.approvalId !== 'string'
    || (value.outcome !== 'allowed-once' && value.outcome !== 'rejected')) return undefined
  return value as unknown as SessionApprovalResponse
}

function questionResponse(value: unknown): SessionQuestionResponse | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !isRecord(value.answer)) return undefined
  const answers = value.answer.answers
  if (!Array.isArray(answers) || !answers.every(answer => isRecord(answer)
    && typeof answer.id === 'string'
    && Array.isArray(answer.selected)
    && answer.selected.every(item => typeof item === 'string')
    && (answer.custom === undefined || typeof answer.custom === 'string'))) return undefined
  return value as unknown as SessionQuestionResponse
}

function matchesQuestions(
  answer: AskUserQuestionAnswer,
  questions: readonly AskUserQuestionItem[],
): boolean {
  if (answer.answers.length !== questions.length) return false
  return answer.answers.every((item, index) => {
    const question = questions[index] as AskUserQuestionItem
    if (item.id !== question.id || new Set(item.selected).size !== item.selected.length) return false
    const custom = item.custom?.trim()
    if (custom !== undefined && custom === '') return false
    if (question.multiSelect !== true
      && (item.selected.length > 1 || (custom !== undefined && item.selected.length > 0))) return false
    const labels = new Set(question.options?.map(option => option.label) ?? [])
    return item.selected.every(label => labels.has(label))
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
