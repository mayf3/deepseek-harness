/**
 * Agent-scoped consumers of the shared Host Schedule management service.
 * @module @deepseek-ai/dsh-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, REQUIRED_TITLE_MESSAGE, ScheduleId, ScheduleInputError, scheduleView } from './domain.ts'
import type {} from './index.ts'
import type {
  AtInput, CronInput, DailyInput, WeeklyInput, InternalScheduleError, ScheduleCreateValue, ScheduleDeleteValue,
  ScheduleListValue, ScheduleTimingChange, ScheduleToolError, ScheduleUpdateValue,
} from './types.ts'

const SHARED_VIEW_PROPERTIES = {
  id: { type: 'string', required: true },
  title: { type: 'string', required: true },
  prompt: { type: 'string', required: true },
  scheduledAt: { type: 'string', required: true },
  state: { type: 'string', required: true, enum: ['scheduled', 'overdue'] },
  deliveryMode: { type: 'string', required: true, const: 'host' },
} as const

const AFTER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'after' },
    afterSeconds: { type: 'integer', required: true },
  },
} as const

const AT_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'at' },
  },
} as const

const EVERY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'every' },
    everySeconds: { type: 'integer', required: true },
  },
} as const

const DAILY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'daily' },
    time: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
  },
} as const

const WEEKLY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'weekly' },
    time: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
    weekdays: { type: 'array', required: true, items: { type: 'integer' } },
  },
} as const

const CRON_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'cron' },
    expression: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
  },
} as const

const VIEW_SCHEMA = {
  oneOf: [
    AFTER_VIEW_SCHEMA, AT_VIEW_SCHEMA, EVERY_VIEW_SCHEMA, DAILY_VIEW_SCHEMA, WEEKLY_VIEW_SCHEMA, CRON_VIEW_SCHEMA,
  ],
} as const

/** Build one exact two-field error schema while preserving its literal code. */
function basicErrorSchema<const C extends string>(code: C) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  } as const
}

const ERROR_SCHEMAS = [
  basicErrorSchema('invalid_prompt'),
  basicErrorSchema('invalid_selector'),
  basicErrorSchema('invalid_rule'),
  basicErrorSchema('invalid_time_zone'),
  basicErrorSchema('not_future'),
  basicErrorSchema('time_out_of_range'),
  basicErrorSchema('frequency_too_high'),
  basicErrorSchema('internal_error'),
] as const

const CREATE_OUTPUT_SCHEMA = { oneOf: [VIEW_SCHEMA, ...ERROR_SCHEMAS] } as const
const LIST_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: VIEW_SCHEMA },
    ...ERROR_SCHEMAS,
  ],
} as const
const DELETE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: false },
        code: { type: 'string', required: true, const: 'schedule_not_found' },
      },
    },
    ...ERROR_SCHEMAS,
  ],
} as const

const UPDATE_OUTPUT_SCHEMA = {
  oneOf: [
    VIEW_SCHEMA,
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        updated: { type: 'boolean', required: true, const: false },
        code: {
          type: 'string',
          required: true,
          enum: ['schedule_not_found', 'schedule_ended', 'schedule_conflict'],
        },
      },
    },
    ...ERROR_SCHEMAS,
  ],
} as const

const CREATE_DESCRIPTION =
  'Create one reminder in the current session. Supply a non-empty prompt, a title, and exactly one selector: '
  + 'a positive safe-integer after_seconds delay, at as a strict offset date-time or local '
  + `date/time object, safe-integer every_seconds of at least ${MIN_EVERY_INTERVAL_SECONDS}, daily `
  + 'as {time: "23:00:00", time_zone: "Asia/Shanghai"}, weekly as '
  + '{time: "09:00:00", time_zone: "Asia/Shanghai", weekdays: [1, 3]} with Monday 1 through Sunday 7, or cron as '
  + '{expression: "*/15 9-17 * * 1-5", time_zone: "Asia/Shanghai"} with the five fields '
  + 'minute hour day-of-month month day-of-week. '
  + `Every creation requires a title of at most ${MAX_TITLE_LENGTH} characters, non-empty after `
  + 'trimming; it names the task on its card, its detail heading, and in the task lists. '
  + 'Daily, weekly, and cron reminders retain that local time and zone; missing wall-clock times skip the date '
  + 'and repeated times use only the earlier instant. '
  + 'A cron day-of-month and day-of-week pair matches when either field matches once both are restricted. '
  + 'Fixed-rate targets stay creation-aligned until an interval edit establishes a new anchor. '
  + 'All four recurring kinds batch one latest occurrence per overdue rule. '
  + 'The Host restores this session when a reminder is due. After downtime, each recurring '
  + 'reminder delivers its latest missed occurrence once. Delivery can repeat after a crash.'

const LIST_DESCRIPTION =
  'List every active reminder in the current session, including its exact id, '
  + 'title, UTC target, scheduled or overdue state, and host delivery mode. '
  + 'The returned order is not significant.'

const DELETE_DESCRIPTION =
  'Delete one retained reminder in the current session by its exact id, whether active or inactive. '
  + 'Unknown or already-deleted ids return deleted false. Deletion does not retract a queued message.'

const UPDATE_DESCRIPTION =
  'Change one reminder in the current session in place, keeping its id and its saved delivery records: '
  + 'address it by the exact id schedule_list returned, then supply a new title or prompt, or exactly one new '
  + 'selector from at, every_seconds, daily, weekly, or cron in the same forms schedule_create accepts. '
  + 'An omitted field keeps its stored value. After is not updatable: create a new reminder for a relative delay. '
  + 'The Host compares the record it finds for that id with the stored one, so a concurrent edit returns '
  + 'schedule_conflict instead of overwriting it; an inactive or unknown reminder returns updated false. '
  + 'Editing an every_seconds interval anchors the new fixed rate at the accepted save time; a name or '
  + 'instruction change alone keeps the committed target.'

/** Deterministic model content for every canonical Schedule value. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  // The ToolRuntime has already validated the value against the lossless-JSON output schema.
  const text = JSON.stringify(value)
  return [{ type: 'text', text }]
}

/** Pure generic pending card. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Stable error for failures not safe to expose. */
function internalError(): InternalScheduleError {
  return { code: 'internal_error', message: 'The schedule operation failed.' }
}

/** Translate invalid input while withholding internal storage failures. */
function operationError(error: unknown): ScheduleToolError {
  return error instanceof ScheduleInputError ? { code: error.code, message: error.message } : internalError()
}

/** One supplied fixed-rate interval: a safe integer at or above the Host floor, or undefined. */
function invalidInterval(everySeconds: number | undefined): ScheduleToolError | undefined {
  if (everySeconds === undefined) return undefined
  if (!Number.isSafeInteger(everySeconds)) {
    return { code: 'invalid_rule', message: 'every_seconds must be a safe integer.' }
  }
  if (everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
    return {
      code: 'frequency_too_high',
      message: `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
    }
  }
  return undefined
}

/** Validate selector constraints that the open parameter root cannot express. */
function validateCreateArgs(args: {
  prompt: string
  title: string
  after_seconds?: number
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleToolError | undefined {
  const keys = Object.keys(args)
  if (keys.some(key => key !== 'prompt'
    && key !== 'title'
    && key !== 'after_seconds'
    && key !== 'at'
    && key !== 'every_seconds'
    && key !== 'daily'
    && key !== 'weekly'
    && key !== 'cron')
    || Number(args.after_seconds !== undefined)
    + Number(args.at !== undefined)
    + Number(args.every_seconds !== undefined)
    + Number(args.daily !== undefined)
    + Number(args.weekly !== undefined)
    + Number(args.cron !== undefined) !== 1) {
    return {
      code: 'invalid_selector',
      message: 'schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  if (args.title.trim().length === 0) {
    return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  }
  if (args.title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  if (args.after_seconds !== undefined
    && (!Number.isSafeInteger(args.after_seconds) || args.after_seconds <= 0)) {
    return { code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' }
  }
  return invalidInterval(args.every_seconds)
}

/** Validate the in-place update's selector count, id, and any supplied name, instruction, or interval. */
function validateUpdateArgs(args: {
  id: string
  title?: string
  prompt?: string
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleToolError | undefined {
  const selectors = [
    args.at !== undefined,
    args.every_seconds !== undefined,
    args.daily !== undefined,
    args.weekly !== undefined,
    args.cron !== undefined,
  ].filter(Boolean).length
  if (Object.keys(args).some(key => key !== 'id'
    && key !== 'title'
    && key !== 'prompt'
    && key !== 'at'
    && key !== 'every_seconds'
    && key !== 'daily'
    && key !== 'weekly'
    && key !== 'cron')
    || selectors > 1) {
    return {
      code: 'invalid_selector',
      message: 'schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.id.length === 0 || args.id.trim() !== args.id) {
    return { code: 'invalid_rule', message: 'schedule_update id must be non-empty without surrounding whitespace.' }
  }
  if (selectors === 0 && args.title === undefined && args.prompt === undefined) {
    return {
      code: 'invalid_selector',
      message: 'schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.title !== undefined && args.title.trim().length === 0) {
    return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  }
  if (args.title !== undefined && args.title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  if (args.prompt !== undefined && args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  return invalidInterval(args.every_seconds)
}

/** The one timing replacement the update carries, or undefined when the request keeps the committed target. */
function timingChangeFrom(args: {
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleTimingChange | undefined {
  if (args.at !== undefined) return { kind: 'at', at: args.at }
  if (args.every_seconds !== undefined) return { kind: 'every', every_seconds: args.every_seconds }
  if (args.daily !== undefined) return { kind: 'daily', daily: args.daily }
  if (args.weekly !== undefined) return { kind: 'weekly', weekly: args.weekly }
  if (args.cron !== undefined) return { kind: 'cron', cron: args.cron }
  return undefined
}

/**
 * Selector parameters shared by `schedule_create` and `schedule_update`, in the order the
 * generated tool catalog states them.
 */
const SELECTOR_PARAMETERS = {
  every_seconds: {
    type: 'number',
    description: `Fixed-rate safe-integer interval in seconds, at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
  },
  daily: {
    type: 'object',
    additionalProperties: false,
    description: 'Daily local wall-clock time in an explicit IANA zone; skips nonexistent times and uses the earlier repeated time once.',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00.' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
    },
  },
  weekly: {
    type: 'object',
    additionalProperties: false,
    description: 'Weekly local wall-clock time on explicit ISO weekdays in an explicit IANA zone; skips nonexistent times and uses the earlier repeated time once per date.',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00.' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
      weekdays: {
        type: 'array',
        required: true,
        description: 'Non-empty ISO weekdays, Monday 1 through Sunday 7, without repetitions.',
        items: { type: 'integer' },
      },
    },
  },
  cron: {
    type: 'object',
    additionalProperties: false,
    description: 'Five-field Vixie cron expression evaluated in an explicit IANA zone; skips nonexistent local times and uses the earlier repeated time once per date.',
    properties: {
      expression: {
        type: 'string',
        required: true,
        description: 'minute hour day-of-month month day-of-week, for example "*/15 9-17 * * 1-5".',
      },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
    },
  },
  at: {
    description: 'Absolute target as strict offset RFC 3339 or local date/time with an explicit IANA zone.',
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', required: true },
          time: { type: 'string', required: true },
          time_zone: { type: 'string', required: true },
        },
      },
    ],
  },
} as const

/**
 * Register all four Schedule tools in one exact agent scope.
 * @param rootCtx - Host context owning the shared Schedule service.
 * @param toolCtx - Exact agent-scoped context receiving the definitions.
 * @param agent - Exact live owner whose session the tools mutate.
 * @returns Idempotent aggregate disposer for the four registrations.
 */
export function registerScheduleTools(
  rootCtx: Context,
  toolCtx: Context,
  agent: Agent,
): () => void {
  const disposers: Array<() => void> = []

  try {
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_create',
      description: CREATE_DESCRIPTION,
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'Reminder content to present when the target becomes due.',
        },
        title: {
          type: 'string',
          required: true,
          description: `Required task name of at most ${MAX_TITLE_LENGTH} characters, non-empty after trimming; `
            + 'it becomes the task card title, the detail heading, and the name in the task lists.',
        },
        after_seconds: {
          type: 'number',
          description: 'Positive safe-integer delay in seconds.',
        },
        ...SELECTOR_PARAMETERS,
      },
      output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleCreateValue> {
        if (exec.agent !== agent) return internalError()
        const invalid = validateCreateArgs(args)
        if (invalid !== undefined) return invalid
        if (exec.signal.aborted) return internalError()
        try {
          return scheduleView(await rootCtx.schedule.create(agent.session.id, args, exec.signal), Date.now())
        } catch (error: unknown) {
          return operationError(error)
        }
      },
      presentCall: args => present('Create reminder', 'other', args.prompt),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_list',
      description: LIST_DESCRIPTION,
      parameters: {},
      output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
      async execute(_args, exec): Promise<ScheduleListValue> {
        if (exec.agent !== agent) return internalError()
        if (exec.signal.aborted) return internalError()
        try {
          const records = await rootCtx.schedule.list({ sessionId: agent.session.id })
          return records.map(record => scheduleView(record, Date.now()))
        } catch (error: unknown) {
          return operationError(error)
        }
      },
      presentCall: () => present('List reminders', 'read'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_delete',
      description: DELETE_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Exact schedule id.' },
      },
      output: { schema: DELETE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleDeleteValue> {
        if (args.id.length === 0 || args.id.trim() !== args.id) {
          return { code: 'invalid_rule', message: 'schedule_delete id must be non-empty without surrounding whitespace.' }
        }
        const id = ScheduleId(args.id)
        if (exec.agent !== agent) return internalError()
        if (exec.signal.aborted) return internalError()
        try {
          return await rootCtx.schedule.delete({ sessionId: agent.session.id, id }, exec.signal)
        } catch (error: unknown) {
          return operationError(error)
        }
      },
      presentCall: args => present('Delete reminder', 'other', args.id),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_update',
      description: UPDATE_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Exact schedule id that schedule_list returned for one reminder.' },
        title: {
          type: 'string',
          description: `New task name of at most ${MAX_TITLE_LENGTH} characters, non-empty after trimming; omitted keeps the stored name.`,
        },
        prompt: {
          type: 'string',
          description: 'New reminder content, non-empty after trimming; omitted keeps the stored instruction.',
        },
        ...SELECTOR_PARAMETERS,
      },
      output: { schema: UPDATE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleUpdateValue> {
        if (exec.agent !== agent) return internalError()
        const invalid = validateUpdateArgs(args)
        if (invalid !== undefined) return invalid
        if (exec.signal.aborted) return internalError()
        const id = ScheduleId(args.id)
        try {
          const sessionId = agent.session.id
          const expected = (await rootCtx.schedule.list({ sessionId }))
            .find(record => record.id === id)
          if (expected === undefined) {
            // The catalog also holds inactive reminders, which is the one not-found
            // case the model can act on: it has to create a new reminder instead.
            const ended = (await rootCtx.schedule.catalog())
              .some(entry => entry.sessionId === sessionId && entry.id === id)
            return { id, updated: false, code: ended ? 'schedule_ended' : 'schedule_not_found' }
          }
          const change = timingChangeFrom(args)
          const result = await rootCtx.schedule.update({
            sessionId,
            id,
            expected,
            ...(change === undefined ? {} : { change }),
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          }, exec.signal)
          return 'record' in result ? scheduleView(result.record, Date.now()) : result
        } catch (error: unknown) {
          return operationError(error)
        }
      },
      presentCall: args => present('Update reminder', 'other', args.id),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
