/** Validate the assembled Windows application before recording release completion. */
import { join } from 'node:path'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'

const paths = resolveDesktopTargetBuildPaths()
const application = join(paths.artifacts, 'win-unpacked')
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version)
await verifyWindowsCode(application)
await smokePreparedRuntime(join(application, 'resources', 'app.asar', 'dsh'),
  join(application, 'DeepSeek Harness.exe'), join(application, 'resources', 'runtime'), descriptor)
