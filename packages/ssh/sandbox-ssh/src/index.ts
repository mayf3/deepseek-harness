/** Remote argv wrapper that selects and applies the sandbox on the SSH host. */
import { Service } from '@deepseek-ai/cordis'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-ssh'
import { z } from 'zod'

const factsSchema = z.object({ argv: z.array(z.string()).min(1), enforcement: z.enum(['full', 'partial']), denialSignatures: z.array(z.string()), runnerFailureRules: z.array(z.object({ allowedExitCodes: z.array(z.number().int()).optional(), fatalSignatures: z.array(z.string()), informationalLines: z.array(z.string()).optional() }).strict()) }).strict()

/** Synchronous wrapping uses verified remote backend facts established before the composition becomes ready. */
export class SshSandboxProvider extends SandboxProvider {
  static inject = ['ssh']
  private facts: z.infer<typeof factsSchema> | undefined
  private node: string | undefined

  /** Verify the remote backend before exposing synchronous argv wrapping. */
  async [Service.init](): Promise<void> {
    const hello = await this.ctx.ssh.ready
    this.node = hello.node
    this.facts = await this.ctx.ssh.request('sandbox', { argv: ['true'], policy: { mode: 'read-only', workspaceRoot: hello.workspace } }, factsSchema)
  }

  override confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    if (this.facts === undefined || this.node === undefined) throw new SandboxUnavailableError(policy.mode, 'SSH sandbox has not established its remote backend')
    const request = {
      policy,
      runner: this.facts.argv[0],
      enforcement: this.facts.enforcement,
      denialSignatures: this.facts.denialSignatures,
    }
    return {
      argv: [this.node, this.ctx.ssh.helperPath, '--confine', JSON.stringify(request), '--', ...argv],
      enforcement: this.facts.enforcement,
      denialSignatures: this.facts.denialSignatures,
      runnerFailureRules: [...this.facts.runnerFailureRules.map(rule => ({ fatalSignatures: rule.fatalSignatures, ...(rule.allowedExitCodes === undefined ? {} : { allowedExitCodes: rule.allowedExitCodes }), ...(rule.informationalLines === undefined ? {} : { informationalLines: rule.informationalLines }) })), { allowedExitCodes: [127], fatalSignatures: ['dsh-ssh-sandbox: '] }],
    }
  }
}

export default SshSandboxProvider
