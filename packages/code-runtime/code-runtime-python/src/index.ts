/**
 * CPython subprocess code runtime for the DeepSeek Harness code-execution seam.
 *
 * This layer of the package ships the versionless fd-3 wire protocol between the
 * Node host and the CPython subprocess; the `PythonCodeRuntime` implementation
 * that drives a `python3 -I` process over it lands on top of this seam. The
 * protocol's host-side codec and hostile-frame validators are re-exported so the
 * runtime and its tests share one wire vocabulary.
 * @module @deepseek-ai/dsh-code-runtime-python
 */

export type { BootMessage, ChildToHost, ReplyMessage } from './protocol.ts'
export {
  checkDoneValue,
  encodeJsonPlain,
  hasNonLosslessNumber,
  hasUnsafeIntegerToken,
  logTruncationMarker,
  validateChildFrame,
} from './protocol.ts'
