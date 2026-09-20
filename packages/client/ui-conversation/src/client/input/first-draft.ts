/** Local text draft retained until the first Workspace and Session can accept it. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FirstDraftState, SubmitOutcome } from '../contract/input.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import { SessionInputShell } from './facade.ts'

/** First-use navigation and the resident destination input. */
interface FirstDraftDeps {
  open(beforeOpen: (id: SessionId) => void, signal: AbortSignal): Promise<SessionId | undefined>
  shell(id: SessionId): SessionInputShell
  /** Whether the borrowed input still belongs to the retained Session generation. */
  isCurrent(id: SessionId, shell: SessionInputShell): boolean
}

/** Owns a root-lifetime text editor without allocating a Host Session. */
export class FirstDraft {
  /** Preparation progress and the recoverable directory failure. */
  readonly state = createSnapshotStore<FirstDraftState>({ busy: false, failed: false })
  /** Local editor owns failed-submit restoration before transfer to a Host Session. */
  readonly shell: SessionInputShell
  private pending: { text: string; transferred: boolean } | undefined

  /** @param ctx - Client plugin lifetime. @param deps - Workspace navigation and Session input access. */
  constructor(private readonly ctx: Context, private readonly deps: FirstDraftDeps) {
    this.shell = new SessionInputShell({
      actx: ctx,
      defaultSink: (text, _attachments, mode, signal) => this.send(text, mode, signal),
      commandAttachments: {
        serialize: () => Promise.resolve([]),
        release: () => {},
        unsupportedNotice: () => '',
      },
    })
    ctx.effect(() => () => { this.shell.dispose() }, 'conversation.input: first-use draft')
  }

  /** Dismiss the preparation failure while retaining the draft. */
  dismiss(): void {
    this.state.set({ ...this.state.getSnapshot(), failed: false })
  }

  /**
   * Move the unsent text to a selected Session.
   * @param id - retained destination Session receiving the unsent text.
   */
  transfer(id: SessionId): void {
    const text = this.pending?.text ?? this.shell.snapshot.draft
    if (text !== '') this.deps.shell(id).setDraft(text)
    if (this.pending !== undefined) this.pending.transferred = true
    this.shell.setDraft('')
    this.dismiss()
  }

  private async send(text: string, mode: InputSubmitMode, signal: AbortSignal): Promise<SubmitOutcome> {
    if (this.pending !== undefined) return { kind: 'error' }
    const pending = { text, transferred: false }
    this.pending = pending
    this.state.set({ busy: true, failed: false })
    let target: SessionInputShell | undefined
    try {
      const id = await this.deps.open((nextId) => { this.transfer(nextId) }, signal)
      if (id === undefined) return { kind: pending.transferred ? 'success' : 'error' }
      target = this.deps.shell(id)
      await this.ctx.serial('conversation/prepare-first-send', id)
      signal.throwIfAborted()
      if (!this.deps.isCurrent(id, target)) return { kind: 'success' }
      target.submit(mode)
      return { kind: 'success' }
    } catch (error) {
      if (!signal.aborted) {
        if (target !== undefined) target.notify('error', error instanceof Error ? error.message : String(error))
        else if (!pending.transferred) this.state.set({ busy: true, failed: true })
      }
      return { kind: pending.transferred ? 'success' : 'error' }
    } finally {
      this.pending = undefined
      this.state.set({ ...this.state.getSnapshot(), busy: false })
    }
  }
}
