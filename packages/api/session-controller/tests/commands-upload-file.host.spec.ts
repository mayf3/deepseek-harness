import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef, ImageAttachmentRef, SaveFileAttachment, SaveFileStreamAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { describe, expect, it, vi } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { FileUploadReceiptId, SessionRequestId } from '../src/types.ts'

const SESSION = SessionId('upload-session')

async function uploadHarness(): Promise<{
  ctx: Context
  controller: SessionCommandController
  agent: Agent
  followup: ReturnType<typeof vi.fn>
  saveFile: ReturnType<typeof vi.fn>
  saveFileStream: ReturnType<typeof vi.fn>
  saveImages: ReturnType<typeof vi.fn>
  disposeAgent: () => void
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SESSION, { meta: { cwd: '/workspace' } })
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const followup = vi.fn()
  const agent = {
    id: session.id,
    session,
    inbox,
    status: 'idle',
    ctx,
    steer: vi.fn(),
    followup,
    cancel: vi.fn(),
  } as unknown as Agent
  const disposeAgent = ctx.agents.register(agent)
  const saveFile = vi.fn((input: SaveFileAttachment): Promise<FileAttachmentRef> => Promise.resolve({
    attachmentId: AttachmentId(`sha256:${'cd'.repeat(32)}`),
    name: input.name ?? 'file',
    bytes: input.data.byteLength,
  }))
  const saveFileStream = vi.fn(async (input: SaveFileStreamAttachment): Promise<FileAttachmentRef> => {
    let bytes = 0
    for await (const chunk of input.data) bytes += chunk.byteLength
    return {
      attachmentId: AttachmentId(`sha256:${'ef'.repeat(32)}`),
      name: input.name ?? 'file',
      bytes,
    }
  })
  const saveImages = vi.fn((): Promise<readonly ImageAttachmentRef[]> =>
    Promise.reject(new Error('fixture did not expect image persistence')))
  ctx.provide('attachments', { saveFile, saveFileStream, saveImages } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture', name: 'Fixture' }],
    resolveModelInfo: () => Promise.resolve({ provider: 'fixture', id: 'fixture-model', name: 'Fixture' }),
  } as never)
  const selection: ModelSelectionRef = {
    current: { provider: 'fixture', model: 'fixture-model' },
    assembled: undefined,
  }
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    selectionFor: () => selection,
    serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
  } as unknown as ApiSessionAgentController
  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    agent,
    followup,
    saveFile,
    saveFileStream,
    saveImages,
    disposeAgent,
  }
}

function promptRequest(content: Parameters<SessionCommandController['prompt']>[0]['content']) {
  return {
    requestId: 'req-1' as SessionRequestId,
    sessionId: SESSION,
    mode: 'queue' as const,
    content,
  }
}

describe('Session file uploads', () => {
  it('stages one verbatim upload and cites it from a later prompt as a file block', async () => {
    const { ctx, controller, agent, followup, saveFile } = await uploadHarness()
    const receipt = await controller.uploadFile({ sessionId: SESSION, data: 'AAAA', name: 'notes.pdf' })
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(receipt.file.name).toBe('notes.pdf')
    expect(receipt.file.bytes).toBe(3)
    expect(controller.resolveStagedFile(SESSION, receipt.receiptId)).toEqual(receipt.file)
    expect(controller.resolveStagedFile(SessionId('other-session'), receipt.receiptId)).toBeUndefined()
    expect(controller.resolveStagedFile(SESSION, 'missing' as FileUploadReceiptId)).toBeUndefined()
    const commandHandler = vi.fn((_invocation: unknown) => ({ kind: 'success' as const }))
    ctx.commands.register({
      name: 'files', description: 'Use staged files', input: { hint: '<task>', attachments: true },
      handler: commandHandler,
    })
    await ctx.commands.execute(
      agent,
      '/files inspect',
      [{ type: 'file', receiptId: receipt.receiptId }],
      new AbortController().signal,
    )
    expect(commandHandler.mock.calls[0]?.[0]).toMatchObject({
      attachments: [{ type: 'file', attachment: receipt.file }],
    })
    await controller.prompt(promptRequest([
      { type: 'file', receiptId: receipt.receiptId },
      { type: 'text', text: 'read it' },
    ]))
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([
      { type: 'file', attachment: receipt.file },
      { type: 'text', text: 'read it' },
    ])
  })

  it('stages a bounded byte stream and forwards cancellation to storage', async () => {
    const { controller, followup, saveFileStream } = await uploadHarness()
    const abort = new AbortController()
    const receipt = await controller.uploadFileStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1, 2)
        yield Uint8Array.of(3, 4, 5)
      })(),
      signal: abort.signal,
      name: 'huge.bin',
    })
    expect(saveFileStream).toHaveBeenCalledWith(expect.objectContaining({
      signal: abort.signal,
      name: 'huge.bin',
    }))
    expect(receipt.file).toMatchObject({ name: 'huge.bin', bytes: 5 })
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([
      { type: 'file', attachment: receipt.file },
    ])
  })

  it('keeps the stream name optional and maps storage failures through the same error vocabulary', async () => {
    const { controller, saveFileStream } = await uploadHarness()
    const stream = (async function* (): AsyncIterable<Uint8Array> {})()
    await expect(controller.uploadFileStream({ sessionId: SESSION, data: stream }))
      .resolves.toMatchObject({ file: { name: 'file', bytes: 0 } })
    expect(saveFileStream).toHaveBeenLastCalledWith({ data: stream })
    saveFileStream.mockRejectedValueOnce('disk offline')
    await expect(controller.uploadFileStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> { yield Uint8Array.of(1) })(),
    }))
      .rejects.toMatchObject({
        code: 'gateway/internal', message: 'failed to store file upload: disk offline',
      })
  })

  it('unregisters its command receipt resolver with the owning plugin fiber', async () => {
    const ctx = new Context()
    const commands = ctx.plugin(CommandRuntime)
    await commands.await()
    const agents = {} as ApiSessionAgentController
    const plugin = {
      apply(ownerCtx: Context) {
        new SessionCommandController(ownerCtx, agents, '/workspace')
      },
    }

    const first = ctx.plugin(plugin)
    await first.await()
    await first.dispose()
    const replacement = ctx.plugin(plugin)
    await replacement.await()
    await replacement.dispose()
    await commands.dispose()
  })

  it('rejects a prompt citing a file that was never staged for the session', async () => {
    const { controller, followup, saveImages } = await uploadHarness()
    await expect(controller.prompt(promptRequest([
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      { type: 'file', receiptId: 'missing-receipt' as FileUploadReceiptId },
    ]))).rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' } })
    expect(followup).not.toHaveBeenCalled()
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('publishes no receipt when its exact Agent is disposed during storage', async () => {
    const { controller, saveFile, disposeAgent } = await uploadHarness()
    const saved = Promise.withResolvers<FileAttachmentRef>()
    saveFile.mockReturnValueOnce(saved.promise)
    const uploading = controller.uploadFile({ sessionId: SESSION, data: 'AAAA', name: 'late.bin' })
    await vi.waitFor(() => { expect(saveFile).toHaveBeenCalledOnce() })
    disposeAgent()
    saved.resolve({
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), name: 'late.bin', bytes: 3,
    })
    await expect(uploading).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('retires accepted receipts after their rpcId becomes observable', async () => {
    const { controller } = await uploadHarness()
    controller.retireObservedPrompt(SESSION, 'not-staged' as SessionRequestId)
    const receipt = await controller.uploadFile({ sessionId: SESSION, data: 'AAAA' })
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    expect(controller.resolveStagedFile(SESSION, receipt.receiptId)).toEqual(receipt.file)
    controller.retireObservedPrompt(SESSION, 'other-request' as SessionRequestId)
    expect(controller.resolveStagedFile(SESSION, receipt.receiptId)).toEqual(receipt.file)
    controller.retireObservedPrompt(SESSION, 'req-1' as SessionRequestId)
    expect(controller.resolveStagedFile(SESSION, receipt.receiptId)).toBeUndefined()
  })

  it('deduplicates a retried rpcId already present in the Agent inbox', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    await controller.prompt(request)
    agent.inbox.append('next-turn', followup.mock.calls[0]?.[0] as UserMessage)
    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('deduplicates a retried rpcId already present in the durable log', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unidentified' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'accepted' }],
      source: { kind: 'user', rpcId: request.requestId },
    }), { surfaceOp: 'append' })

    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects when the Agent disappears during prompt admission', async () => {
    const { controller, saveImages, disposeAgent } = await uploadHarness()
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const prompting = controller.prompt(promptRequest([
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    ]))
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    disposeAgent()
    admitted.resolve([{
      attachmentId: AttachmentId('admitted-image'), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }])
    await expect(prompting).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('rejects when a previously bound receipt retires during image admission', async () => {
    const { controller, saveImages } = await uploadHarness()
    const receipt = await controller.uploadFile({ sessionId: SESSION, data: 'AAAA' })
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const prompting = controller.prompt({
      ...promptRequest([
        { type: 'file', receiptId: receipt.receiptId },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ]),
      requestId: 'req-2' as SessionRequestId,
    })
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    controller.retireObservedPrompt(SESSION, 'req-1' as SessionRequestId)
    admitted.resolve([{
      attachmentId: AttachmentId('admitted-image'), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }])
    await expect(prompting).rejects.toMatchObject({
      code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' },
    })
  })

  it('keeps the prior receipt binding when a later prompt attempt fails', async () => {
    const { controller, followup } = await uploadHarness()
    const receipt = await controller.uploadFile({ sessionId: SESSION, data: 'AAAA' })
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    followup.mockImplementationOnce(() => { throw new Error('busy') })
    await expect(controller.prompt({
      ...promptRequest([{ type: 'file', receiptId: receipt.receiptId }]),
      requestId: 'req-2' as SessionRequestId,
    })).rejects.toMatchObject({ code: 'session/agent-busy' })
    controller.retireObservedPrompt(SESSION, 'req-1' as SessionRequestId)
    expect(controller.resolveStagedFile(SESSION, receipt.receiptId)).toBeUndefined()
  })

  it('restores an unbound receipt after prompt delivery fails', async () => {
    const { controller, followup } = await uploadHarness()
    const receipt = await controller.uploadFile({ sessionId: SESSION, data: 'AAAA' })
    followup.mockImplementationOnce(() => { throw new Error('busy') })
    await expect(controller.prompt(promptRequest([
      { type: 'file', receiptId: receipt.receiptId },
    ]))).rejects.toMatchObject({ code: 'session/agent-busy' })
    controller.retireObservedPrompt(SESSION, 'req-1' as SessionRequestId)
    expect(controller.resolveStagedFile(SESSION, receipt.receiptId)).toEqual(receipt.file)
  })

  it('retires a prompt-bound receipt when its queued occurrence is removed', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const receipt = await controller.uploadFile({ sessionId: SESSION, data: 'AAAA' })
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    const queued = followup.mock.calls[0]?.[0] as UserMessage
    agent.inbox.append('next-turn', queued)
    expect(controller.updateQueue({
      sessionId: SESSION,
      itemId: queued.id,
      action: { kind: 'remove' },
    })).toEqual({ accepted: true })
    expect(controller.resolveStagedFile(SESSION, receipt.receiptId)).toBeUndefined()
  })

  it('drops staged uploads with the session while the stored object stays durable', async () => {
    const { controller, followup } = await uploadHarness()
    const receipt = await controller.uploadFile({ sessionId: SESSION, data: 'AAAA' })
    expect(receipt.file.name).toBe('file')
    controller.releaseStagedFiles(SESSION)
    await expect(controller.prompt(promptRequest([
      { type: 'file', receiptId: receipt.receiptId },
    ]))).rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' } })
    expect(followup).not.toHaveBeenCalled()
  })

  it('keeps separate names for identical bytes uploaded more than once', async () => {
    const { controller, followup } = await uploadHarness()
    const first = await controller.uploadFile({ sessionId: SESSION, data: 'AAAA', name: 'first.txt' })
    const second = await controller.uploadFile({ sessionId: SESSION, data: 'AAAA', name: 'second.txt' })
    expect(first.file.attachmentId).toBe(second.file.attachmentId)
    expect(first.receiptId).not.toBe(second.receiptId)

    await controller.prompt(promptRequest([
      { type: 'file', receiptId: first.receiptId },
      { type: 'file', receiptId: second.receiptId },
    ]))

    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([
      { type: 'file', attachment: first.file },
      { type: 'file', attachment: second.file },
    ])
  })

  it('maps a non-canonical payload to the wire attachment error', async () => {
    const { controller, saveFile } = await uploadHarness()
    await expect(controller.uploadFile({ sessionId: SESSION, data: 'not base64!!' }))
      .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'INVALID_FILE_BASE64' } })
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('maps an unexpected storage failure to the internal wire error', async () => {
    const { controller, saveFile } = await uploadHarness()
    saveFile.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(controller.uploadFile({ sessionId: SESSION, data: 'AAAA' }))
      .rejects.toMatchObject({
        code: 'gateway/internal',
        message: 'failed to store file upload: Error: disk unavailable',
      })
  })
})
