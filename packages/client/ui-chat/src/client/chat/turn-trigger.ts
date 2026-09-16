/** Presentation of durable non-human messages claimed to begin a Turn. */
import type { ContextMessageNode } from '../contract/snapshot.ts'
import type { ChatKey } from '../locale.ts'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function field(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === 'string' ? source[key] : ''
}

function jsonLine(text: string, prefix: string): unknown {
  const line = text.split('\n').find(value => value.startsWith(prefix))
  if (line === undefined) return undefined
  try { return JSON.parse(line.slice(prefix.length)) as unknown } catch {
    // Foreign or truncated notification text need not retain the producer's JSON framing.
    return undefined
  }
}

/**
 * Describe a waking message using its source and recognized producer framing.
 * @param node - durable context, including the original notification body.
 * @returns localized title key, bounded subject, producer, and original detail.
 */
export function turnTriggerDetails(node: ContextMessageNode): {
  title: ChatKey
  subject: string
  producer: string
  text: string
} {
  const source = record(node.source)
  const kind = field(source, 'kind')
  const plugin = field(source, 'plugin')
  const text = node.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const summary = field(source, 'summary')
  let title: ChatKey = 'message.trigger.request'
  let subject = summary || field(source, 'senderName') || field(source, 'senderSessionId') || plugin || kind
  switch (kind) {
    case 'goal': {
      title = 'message.trigger.goal'
      const objective = jsonLine(text, 'Objective: ')
      subject = typeof objective === 'string' ? objective : field(source, 'goalId')
      break
    }
    case 'agent-message':
      title = 'message.trigger.agent'
      subject = field(source, 'senderName') || field(source, 'senderSessionId')
      break
    case 'team-message':
      title = 'message.trigger.team'
      subject = field(source, 'senderName') || field(source, 'senderId')
      break
    case 'subagent-settled': {
      title = 'message.trigger.subagent'
      const id = field(source, 'senderSessionId')
      const prefix = `Background subagent ${id} `
      const ending = text.startsWith(prefix) ? text.slice(prefix.length).split('\n')[0] : ''
      if (ending === 'finished and will do no further work unless you send it more.') title = 'message.trigger.subagentDone'
      if (ending === 'was stopped before it finished.') title = 'message.trigger.subagentStopped'
      if (ending === 'failed before it finished.') title = 'message.trigger.subagentFailed'
      subject = field(source, 'senderName') || id
      break
    }
    case 'webhook':
      title = field(source, 'provider') === 'github' ? 'message.trigger.github' : 'message.trigger.webhook'
      subject = summary || field(source, 'ruleId')
      break
    case 'plugin':
      if (plugin === 'schedule') {
        title = 'message.trigger.schedule'
        const prompt = jsonLine(text, 'reminder_prompt_json: ')
        const batch = jsonLine(text, 'reminders_json: ')
        subject = typeof prompt === 'string' ? prompt : Array.isArray(batch)
          ? batch.map(item => field(record(item), 'reminder_prompt')).filter(Boolean).join(' · ') : summary
      } else if (plugin === 'tool-jobs') {
        title = 'message.trigger.job'
        const job = /^background job (\S+) \(([^:]+): (.*?)\) finished \[status: ([\w-]+)(?:, ([^\]\n]*))?\]/.exec(text)
        const status = job?.[4]
        if (status === 'completed') title = 'message.trigger.jobDone'
        if (status === 'failed') title = 'message.trigger.jobFailed'
        if (status === 'stopped' || status === 'aborted' || status === 'killed') title = 'message.trigger.jobStopped'
        subject = job?.[3] || job?.[1] || summary
      } else if (plugin === 'cordis-host-runner') {
        title = 'message.trigger.plugin'
        const success = /^Cordis (run|update) (.+?) completed successfully\./.exec(text)
        const rejected = /^The user rejected Cordis (run|update) (.+?)\./.exec(text)
        const failed = /^Cordis (run|update) (.+?) failed after cordis_run/.exec(text)
        const runtime = /^Cordis (?:Client UI|Host handler) (.+?) failed /.exec(text)
          ?? /^Cordis (?:Host|Client) guard rejected runtime code in (.+?)\.\n/.exec(text + '\n')
        if (success !== null) {
          title = success[1] === 'update' ? 'message.trigger.pluginUpdated' : 'message.trigger.pluginDone'
          subject = success[2] ?? plugin
        } else if (rejected !== null) {
          title = 'message.trigger.pluginRejected'
          subject = rejected[2] ?? plugin
        } else if (failed !== null) {
          title = 'message.trigger.pluginFailed'
          subject = failed[2] ?? plugin
        } else if (runtime !== null) {
          title = 'message.trigger.pluginError'
          subject = runtime[1] ?? plugin
        }
      }
      break
    default:
      // Custom sources remain visible without attributing unrecorded identity or success.
      break
  }
  return { title, subject: subject.slice(0, 120), producer: plugin || kind, text }
}
