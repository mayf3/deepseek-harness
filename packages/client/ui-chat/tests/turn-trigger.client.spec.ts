/** Source attribution and conservative parsing of waking notification titles. */
import { expect, it } from 'vitest'
import { turnTriggerDetails } from '../src/client/chat/turn-trigger.ts'
import { contextForm, contextProducer } from '../src/client/conversation-nodes/event-projection.ts'

function details(source: unknown, text: string) {
  return turnTriggerDetails({ kind: 'context', seq: 1, time: 1, source,
    content: [{ type: 'text', text }], producer: contextProducer(source), form: contextForm(source) })
}

it.each(['completed', 'failed', 'killed', 'future'])('uses the durable job source for status %s', (status) => {
  expect(details({ kind: 'plugin', plugin: 'tool-jobs' },
    `background job bash-39 (bash: PR merge check) finished [status: ${status}, exit code 0].`))
    .toEqual({ title: 'message.trigger.job', icon: 'job' })
})

it('classifies schedule and goal triggers', () => {
  expect(details({ kind: 'plugin', plugin: 'schedule' }, 'reminder_prompt_json: "检查合并"'))
    .toEqual({ title: 'message.trigger.schedule', icon: 'schedule' })
  expect(details({ kind: 'goal', goalId: 'g1' }, 'Objective: "完成测试"'))
    .toEqual({ title: 'message.trigger.goal', icon: 'goal' })
})

it.each([
  'Cordis run plug/pkg (r1) completed successfully.',
  'The user rejected Cordis run plug/pkg (r1).',
  'Cordis update plug/pkg (r1) failed after cordis_run returned starting: broken',
  'Cordis Client guard rejected runtime code in plug/pkg (r1).',
])('uses the durable Cordis source independently of producer text %s', (text) => {
  expect(details({ kind: 'plugin', plugin: 'cordis-host-runner' }, text).title).toBe('message.trigger.plugin')
})

it('uses the durable subagent source independently of settlement wording', () => {
  expect(details({ kind: 'subagent-settled', senderSessionId: 'child-1' }, 'future settlement wording'))
    .toEqual({ title: 'message.trigger.subagent', icon: 'subagent' })
})

it('keeps unknown sources and unrecognized status neutral', () => {
  expect(details({ kind: 'custom-extension' }, 'completed successfully')).toMatchObject({
    title: 'message.trigger.request', icon: 'request',
  })
  expect(details({ kind: 'plugin', plugin: 'tool-jobs', summary: 'job update' }, 'future notice format'))
    .toEqual({ title: 'message.trigger.job', icon: 'job' })
})

it.each([
  [{ kind: 'agent-message', senderSessionId: 'agent-1' }, '', 'agent'],
  [{ kind: 'team-message', senderName: 'Reviewer' }, '', 'team'],
  [{ kind: 'subagent-settled', senderSessionId: 'child-1' }, '', 'subagent'],
  [{ kind: 'webhook', provider: 'github', ruleId: 'review' }, '', 'github'],
  [{ kind: 'webhook', provider: 'custom', ruleId: 'deploy' }, '', 'webhook'],
  [{ kind: 'plugin', plugin: 'tool-jobs' }, 'future notice format', 'job'],
  [{ kind: 'plugin', plugin: 'cordis-host-runner' }, 'future notice format', 'plugin'],
] as const)('selects the source-family icon for %o', (source, text, icon) => {
  expect(details(source, text).icon).toBe(icon)
})
