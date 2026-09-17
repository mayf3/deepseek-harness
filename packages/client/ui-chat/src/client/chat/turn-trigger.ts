/** Presentation of durable non-human messages claimed to begin a Turn. */
import type { ContextMessageNode } from '../contract/snapshot.ts'
import type { ChatKey } from '../locale.ts'

/** Existing primitive glyph selected for a Turn trigger's source family. */
export type TurnTriggerIcon = 'agent' | 'github' | 'goal' | 'job' | 'plugin' | 'request' | 'schedule' | 'subagent' | 'team' | 'webhook'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function field(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === 'string' ? source[key] : ''
}

/**
 * Describe a waking message using its source and recognized producer framing.
 * @param node - durable context, including the original notification body.
 * @returns localized title key and source-family icon.
 */
export function turnTriggerDetails(node: ContextMessageNode): {
  title: ChatKey
  icon: TurnTriggerIcon
} {
  const source = record(node.source)
  const kind = field(source, 'kind')
  const plugin = field(source, 'plugin')
  const text = node.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  let title: ChatKey = 'message.trigger.request'
  let icon: TurnTriggerIcon = 'request'
  switch (kind) {
    case 'goal': {
      title = 'message.trigger.goal'
      icon = 'goal'
      break
    }
    case 'agent-message':
      title = 'message.trigger.agent'
      icon = 'agent'
      break
    case 'team-message':
      title = 'message.trigger.team'
      icon = 'team'
      break
    case 'subagent-settled': {
      title = 'message.trigger.subagent'
      icon = 'subagent'
      const id = field(source, 'senderSessionId')
      const prefix = `Background subagent ${id} `
      const ending = text.startsWith(prefix) ? text.slice(prefix.length).split('\n')[0] : ''
      if (ending === 'finished and will do no further work unless you send it more.') title = 'message.trigger.subagentDone'
      if (ending === 'was stopped before it finished.') title = 'message.trigger.subagentStopped'
      if (ending === 'failed before it finished.') title = 'message.trigger.subagentFailed'
      break
    }
    case 'webhook': {
      const github = field(source, 'provider') === 'github'
      title = github ? 'message.trigger.github' : 'message.trigger.webhook'
      icon = github ? 'github' : 'webhook'
      break
    }
    case 'plugin':
      if (plugin === 'schedule') {
        title = 'message.trigger.schedule'
        icon = 'schedule'
      } else if (plugin === 'tool-jobs') {
        title = 'message.trigger.job'
        icon = 'job'
        const job = /^background job (\S+) \(([^:]+): (.*?)\) finished \[status: ([\w-]+)(?:, ([^\]\n]*))?\]/.exec(text)
        const status = job?.[4]
        if (status === 'completed') title = 'message.trigger.jobDone'
        if (status === 'failed') title = 'message.trigger.jobFailed'
        if (status === 'stopped' || status === 'aborted' || status === 'killed') title = 'message.trigger.jobStopped'
      } else if (plugin === 'cordis-host-runner') {
        title = 'message.trigger.plugin'
        icon = 'plugin'
        const success = /^Cordis (run|update) (.+?) completed successfully\./.exec(text)
        const rejected = /^The user rejected Cordis (run|update) (.+?)\./.exec(text)
        const failed = /^Cordis (run|update) (.+?) failed after cordis_run/.exec(text)
        const runtime = /^Cordis (?:Client UI|Host handler) (.+?) failed /.exec(text)
          ?? /^Cordis (?:Host|Client) guard rejected runtime code in (.+?)\.\n/.exec(text + '\n')
        if (success !== null) {
          title = success[1] === 'update' ? 'message.trigger.pluginUpdated' : 'message.trigger.pluginDone'
        } else if (rejected !== null) {
          title = 'message.trigger.pluginRejected'
        } else if (failed !== null) {
          title = 'message.trigger.pluginFailed'
        } else if (runtime !== null) {
          title = 'message.trigger.pluginError'
        }
      }
      break
    default:
      // Custom sources remain visible without attributing unrecorded identity or success.
      break
  }
  return { title, icon }
}
