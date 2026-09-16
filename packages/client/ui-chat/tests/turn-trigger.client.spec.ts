/** Source attribution and conservative parsing of waking notification titles. */
import { expect, it } from 'vitest'
import { turnTriggerDetails } from '../src/client/chat/turn-trigger.ts'
import { contextForm, contextProvenance } from '../src/client/conversation-nodes/event-projection.ts'

function details(source: unknown, text: string) {
  return turnTriggerDetails({ kind: 'context', seq: 1, time: 1, source,
    content: [{ type: 'text', text }], provenance: contextProvenance(source), form: contextForm(source) })
}

it.each([
  ['completed', 'jobDone'], ['failed', 'jobFailed'], ['killed', 'jobStopped'], ['future', 'job'],
])('uses recorded job status %s', (status, key) => {
  expect(details({ kind: 'plugin', plugin: 'tool-jobs' },
    `background job bash-39 (bash: PR merge check) finished [status: ${status}, exit code 0].`))
    .toMatchObject({ title: `message.trigger.${key}`, subject: 'PR merge check' })
})

it('extracts schedule and goal subjects without exposing producer framing', () => {
  expect(details({ kind: 'plugin', plugin: 'schedule' }, 'reminder_prompt_json: "检查合并"'))
    .toMatchObject({ title: 'message.trigger.schedule', subject: '检查合并' })
  expect(details({ kind: 'plugin', plugin: 'schedule' }, 'reminders_json: [{"reminder_prompt":"检查"},{"reminder_prompt":"提醒"}]').subject)
    .toBe('检查 · 提醒')
  expect(details({ kind: 'goal', goalId: 'g1' }, 'Objective: "完成测试"'))
    .toMatchObject({ title: 'message.trigger.goal', subject: '完成测试' })
  expect(details({ kind: 'goal', goalId: 'g1' }, 'Objective: {broken').subject).toBe('g1')
})

it.each([
  ['Cordis run plug/pkg (r1) completed successfully.', 'pluginDone'],
  ['The user rejected Cordis run plug/pkg (r1).', 'pluginRejected'],
  ['Cordis update plug/pkg (r1) failed after cordis_run returned starting: broken', 'pluginFailed'],
  ['Cordis Client guard rejected runtime code in plug/pkg (r1).', 'pluginError'],
])('recognizes runner outcome %s', (text, key) => {
  expect(details({ kind: 'plugin', plugin: 'cordis-host-runner' }, text).title).toBe(`message.trigger.${key}`)
})

it('keeps unknown sources and unrecognized status neutral', () => {
  expect(details({ kind: 'custom-extension' }, 'completed successfully')).toMatchObject({
    title: 'message.trigger.request', subject: 'custom-extension', text: 'completed successfully',
  })
  expect(details({ kind: 'plugin', plugin: 'tool-jobs', summary: 'job update' }, 'future notice format'))
    .toMatchObject({ title: 'message.trigger.job', subject: 'job update' })
})
