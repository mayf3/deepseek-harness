/** Package-private STARTUPINFOEXW ownership for atomic Job attachment. */

import koffi from 'koffi'
import * as abi from './abi.ts'
import { STARTUPINFOW, throwWin32 } from './ffi.ts'
import type { NativePtr, StartupInfoInput, Win32ProcessBindings } from './ffi.ts'

type Ptr = ReturnType<typeof koffi.pointer>
const PVOID: Ptr = koffi.pointer('void')

const STARTUPINFOEXW = koffi.struct('DSH_STARTUPINFOEXW', {
  StartupInfo: STARTUPINFOW,
  lpAttributeList: PVOID,
})

/* v8 ignore start -- the native header probe pins this x64 layout. */
if (STARTUPINFOEXW.size !== abi.STARTUPINFOEXW_SIZE) {
  throw new Error(`STARTUPINFOEXW layout mismatch: koffi computed ${STARTUPINFOEXW.size}, expected ${abi.STARTUPINFOEXW_SIZE}`)
}
/* v8 ignore stop */

/** One extended startup record whose attribute list remains valid through CreateProcess. */
export interface JobStartupInfo {
  /** STARTUPINFOEXW pointer passed to CreateProcessAsUserW. */
  readonly pointer: NativePtr
  /** Release the initialized process attribute list after CreateProcessAsUserW returns. */
  dispose(): void
}

function queryAttributeListSize(api: Win32ProcessBindings): number {
  const sizeSlot = koffi.alloc('size_t', 1) as NativePtr
  try {
    api.initializeProcThreadAttributeList(null, 1, 0, sizeSlot)
    const attributeBytes = koffi.decode(sizeSlot, 'size_t') as number
    if (attributeBytes === 0) {
      throwWin32(
        api,
        'InitializeProcThreadAttributeList',
        api.getLastError(),
        'process-attribute size query',
      )
    }
    return attributeBytes
  } finally {
    koffi.free(sizeSlot)
  }
}

/**
 * Build a STARTUPINFOEXW that assigns the restricted child to `job` during creation.
 * @param api - active binding table.
 * @param fields - inherited stdio fields for the nested STARTUPINFOW.
 * @param job - caller-owned Job attached before any child thread exists.
 * @returns extended startup pointer and its post-CreateProcess disposer.
 */
export function createJobStartupInfo(
  api: Win32ProcessBindings,
  fields: Omit<StartupInfoInput, 'cb'>,
  job: NativePtr,
): JobStartupInfo {
  const attributeList = Buffer.alloc(queryAttributeListSize(api))
  const sizeSlot = koffi.alloc('size_t', 1) as NativePtr
  let initialized = false
  let jobList: NativePtr | undefined
  try {
    koffi.encode(sizeSlot, 'size_t', attributeList.length)
    if (api.initializeProcThreadAttributeList(attributeList, 1, 0, sizeSlot) === 0) {
      throwWin32(
        api,
        'InitializeProcThreadAttributeList',
        api.getLastError(),
        'process-attribute initialization',
      )
    }
    initialized = true
    jobList = koffi.alloc(PVOID, 1) as NativePtr
    koffi.encode(jobList, PVOID, job)
    if (api.updateProcThreadAttribute(
      attributeList,
      0,
      abi.PROC_THREAD_ATTRIBUTE_JOB_LIST,
      jobList,
      abi.POINTER_SIZE,
      null,
      null,
    ) === 0) {
      throwWin32(
        api,
        'UpdateProcThreadAttribute',
        api.getLastError(),
        'PROC_THREAD_ATTRIBUTE_JOB_LIST',
      )
    }
    const pointer = koffi.alloc(STARTUPINFOEXW, 1) as NativePtr
    try {
      koffi.encode(pointer, STARTUPINFOEXW, {
        StartupInfo: { ...fields, cb: abi.STARTUPINFOEXW_SIZE },
        lpAttributeList: attributeList,
      })
    } catch (error) {
      /* v8 ignore start -- staging a STARTUPINFOEXW encode failure requires replacing Koffi's encoder. */
      koffi.free(pointer)
      throw error
      /* v8 ignore stop */
    }
    return {
      pointer,
      dispose: () => {
        try {
          api.deleteProcThreadAttributeList(attributeList)
        } finally {
          koffi.free(jobList)
          koffi.free(pointer)
        }
      },
    }
  } catch (error) {
    if (initialized) api.deleteProcThreadAttributeList(attributeList)
    if (jobList !== undefined) koffi.free(jobList)
    throw error
  } finally {
    koffi.free(sizeSlot)
  }
}
