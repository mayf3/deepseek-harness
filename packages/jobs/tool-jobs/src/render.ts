/**
 * Model-facing rendering of registry reads: the consuming delta as the
 * shell tools have always shown it (stdout, then one marked stderr section),
 * the `[status: …]` line, and the public job projection the tool schemas
 * expose.
 * @module @deepseek-ai/dsh-tool-jobs/render
 */

import type { JobChunk, JobView } from '@deepseek-ai/dsh-jobs'

/** Job state safe for model-authored programs; ownership and offsets are omitted. */
export interface PublicJobSnapshot {
  id: string
  kind: string
  label: string
  status: JobView['status']
  /** The live progress line while running, the terminal reason once settled. */
  detail?: string
  startedAt: number
  finishedAt?: number
}

/**
 * The one-line qualifier the model reads beside a status: live progress while
 * the job runs, the terminal reason once it settled.
 * @param job - the job projection.
 * @returns the qualifier, or undefined when the job carries neither.
 */
export function jobDetail(job: Pick<JobView, 'progress' | 'detail'>): string | undefined {
  return job.progress ?? job.detail
}

/**
 * Remove ownership, offsets, and limits from a registry projection.
 * @param job - the registry projection.
 * @returns the model-safe projection.
 */
export function publicJob(job: JobView): PublicJobSnapshot {
  const detail = jobDetail(job)
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...detail !== undefined ? { detail } : {},
    startedAt: job.startedAt,
    ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
  }
}

/**
 * Render generic status with optional detail.
 * @param snapshot - job state to render.
 * @returns a bracketed status line.
 */
export function statusLine(snapshot: Pick<PublicJobSnapshot, 'status' | 'detail'>): string {
  return snapshot.detail !== undefined
    ? `[status: ${snapshot.status}, ${snapshot.detail}]`
    : `[status: ${snapshot.status}]`
}

/**
 * Render one consuming read for the model: stdout and unlabeled chunks in
 * order, then every stderr chunk in one `[stderr]` section, exactly as the
 * shell tools render a foreground result. `log` chunks are producer
 * narration for observers and never reach the model. A lossy read — the
 * cursor fell behind the ring's retention — ends with a dropped-output
 * notice.
 * @param chunks - the chunks since the model cursor, in offset order.
 * @param lossy - whether bytes before `chunks` were evicted unread.
 * @returns the delta text, possibly empty.
 */
export function renderModelDelta(chunks: readonly JobChunk[], lossy: boolean): string {
  const out = chunks.filter(chunk => chunk.channel === undefined || chunk.channel === 'stdout').map(chunk => chunk.text).join('')
  const err = chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  const body = out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
  if (!lossy) return body
  return `${body}${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}[some output was dropped from memory before this read]`
}
