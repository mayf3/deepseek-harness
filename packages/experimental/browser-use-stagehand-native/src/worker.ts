/** Isolated attachment owns SDK sockets while the host owns model inference. */

import { parentPort, workerData } from 'node:worker_threads'
import { ClientLLMSchema } from '@browserbasehq/stagehand'
import type { ClientLLM } from '@browserbasehq/stagehand'
import { z } from 'zod'
import { browserInputs, openNativeBrowser } from './native.ts'
import { answer, request } from './worker-rpc.ts'

const port = parentPort
if (port === null) throw new Error('Stagehand attachment requires a Worker parent')
const { extensionId, ...config } = z.object({
  mode: z.literal('attach'),
  cdpEndpoint: z.string(),
  extensionId: z.string().optional(),
  headless: z.boolean(),
  operationTimeoutMs: z.number().int().positive(),
  shutdownGraceMs: z.number().int().positive(),
}).parse(workerData)
const generate = ClientLLMSchema.shape.generate.implementAsync(params => request(port, 'generate', params) as ReturnType<ClientLLM['generate']>)
const methodSchema = z.enum(Object.keys(browserInputs) as [keyof typeof browserInputs, ...Array<keyof typeof browserInputs>])
const opening = openNativeBrowser(
  { ...config, ...extensionId === undefined ? {} : { extensionId } },
  async params => generate(params),
)
// Initialization failure stays observable through the host's ready request.
void opening.catch((error: unknown) => { void error })
port.on('message', (raw: unknown) => {
  void answer(raw, async (method, args) => {
    const native = await opening
    if (method === 'ready') return
    if (method === 'close') return native.close()
    return native.execute(methodSchema.parse(method), args)
  }).catch((error: unknown) => { throw error })
})
