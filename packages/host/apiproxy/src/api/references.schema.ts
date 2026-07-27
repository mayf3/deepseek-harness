/**
 * Reference-domain wire schemas.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/api/references.schema
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'

const referenceRequestSchema = z.object({
  sessionId: sessionIdSchema,
  query: z.string(),
})

/** reference.files request payload. */
export const referenceFilesRequestSchema = referenceRequestSchema satisfies
  z.ZodType<Wire<RequestPayload<'reference.files'>>>

/** reference.files response value. */
export const referenceFilesValueSchema = z.object({
  items: z.array(z.object({
    path: z.string(),
    kind: z.union([z.literal('file'), z.literal('directory')]),
  })),
}) satisfies z.ZodType<Wire<ResponseValue<'reference.files'>>>

/** reference.sessions request payload. */
export const referenceSessionsRequestSchema = referenceRequestSchema satisfies
  z.ZodType<Wire<RequestPayload<'reference.sessions'>>>

/** reference.sessions response value. */
export const referenceSessionsValueSchema = z.object({
  items: z.array(z.object({
    sessionId: sessionIdSchema,
    label: z.string(),
    cwd: z.string().optional(),
    createdAt: z.number(),
    mention: z.string(),
  })),
}) satisfies z.ZodType<Wire<ResponseValue<'reference.sessions'>>>
