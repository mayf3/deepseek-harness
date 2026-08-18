import koffi from 'koffi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJobStartupInfo } from '../src/job-attribute.ts'
import type { NativePtr, Win32ProcessBindings } from '../src/ffi.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function bindings(): {
  api: Win32ProcessBindings
  deleteProcThreadAttributeList: ReturnType<typeof vi.fn>
} {
  const deleteProcThreadAttributeList = vi.fn()
  const api = {
    initializeProcThreadAttributeList: vi.fn((list: Buffer | null, _count: number, _flags: number, size: NativePtr) => {
      if (list === null) {
        koffi.encode(size, 'size_t', 64)
        return 0
      }
      return 1
    }),
    updateProcThreadAttribute: vi.fn(() => 1),
    deleteProcThreadAttributeList,
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
  } as unknown as Win32ProcessBindings
  return { api, deleteProcThreadAttributeList }
}

const fields = {
  dwFlags: 0x100,
  hStdInput: 1n as NativePtr,
  hStdOutput: 2n as NativePtr,
  hStdError: 3n as NativePtr,
}

describe('createJobStartupInfo allocation cleanup', () => {
  it('frees the size slot when attribute-list buffer allocation throws', () => {
    const { api, deleteProcThreadAttributeList } = bindings()
    const free = vi.spyOn(koffi, 'free')
    vi.spyOn(Buffer, 'alloc').mockImplementationOnce(() => { throw new Error('buffer allocation failed') })
    expect(() => createJobStartupInfo(api, fields, 50n as NativePtr)).toThrow('buffer allocation failed')
    expect(free).toHaveBeenCalledOnce()
    expect(deleteProcThreadAttributeList).not.toHaveBeenCalled()
  })

  it('deletes the initialized list and frees the Job value when attachment fails', () => {
    const { api, deleteProcThreadAttributeList } = bindings()
    api.updateProcThreadAttribute = vi.fn(() => 0)
    const free = vi.spyOn(koffi, 'free')
    expect(() => createJobStartupInfo(api, fields, 50n as NativePtr)).toThrow('PROC_THREAD_ATTRIBUTE_JOB_LIST')
    expect(deleteProcThreadAttributeList).toHaveBeenCalledOnce()
    expect(free).toHaveBeenCalledTimes(3)
  })

  it('frees every native allocation after the caller disposes the startup record', () => {
    const { api, deleteProcThreadAttributeList } = bindings()
    const free = vi.spyOn(koffi, 'free')
    const startup = createJobStartupInfo(api, fields, 50n as NativePtr)
    startup.dispose()
    expect(free).toHaveBeenCalledTimes(4)
    expect(deleteProcThreadAttributeList).toHaveBeenCalledOnce()
  })
})
