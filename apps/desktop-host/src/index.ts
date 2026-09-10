/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

async function main(): Promise<void> {
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url))],
    args: ['--no-open'],
  })
  const stop = async (): Promise<void> => {
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    if (process.connected) process.disconnect()
  }
  process.on('message', (message: { type?: string } | null) => {
    if (message?.type === 'shutdown') void stop()
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  process.send?.({ type: 'ready', url })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.send?.({ type: 'fatal', message })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
