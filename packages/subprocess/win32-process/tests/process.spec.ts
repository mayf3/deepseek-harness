import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  Win32Error,
  closeHandleChecked,
  drainPipe,
  spawnInheritedJobProcess,
  spawnPipedProcess,
} from '../src/index.ts'
import {
  EXTENDED_STARTUPINFO_PRESENT,
  POINTER_SIZE,
  PROC_THREAD_ATTRIBUTE_JOB_LIST,
} from '../src/abi.ts'
import { PROCESS_INFORMATION } from '../src/ffi.ts'
import type { NativePtr, Win32ProcessBindings } from '../src/index.ts'

const PVOID = koffi.pointer('void')

function inheritedApi(overrides: Partial<Win32ProcessBindings> = {}): {
  api: Win32ProcessBindings
  events: string[]
  createProcessAsUserW: ReturnType<typeof vi.fn>
  initializeProcThreadAttributeList: ReturnType<typeof vi.fn>
  updateProcThreadAttribute: ReturnType<typeof vi.fn>
  attachedJob: () => NativePtr | null
} {
  const events: string[] = []
  let attachedJob: NativePtr | null = null
  const createProcessAsUserWImpl: Win32ProcessBindings['createProcessAsUserW'] =
    overrides.createProcessAsUserW
    ?? ((_token, _app, _line, _pa, _ta, _inherit, _flags, _env, _cwd, _startup, info) => {
      events.push('create')
      koffi.encode(info, PROCESS_INFORMATION, {
        hProcess: 60n,
        hThread: 61n,
        dwProcessId: 1234,
        dwThreadId: 5678,
      })
      return 1
    })
  const createProcessAsUserW = vi.fn(createProcessAsUserWImpl)
  const initializeProcThreadAttributeList = vi.fn((list: Buffer | null, _count: number, _flags: number, size: NativePtr) => {
    if (list === null) {
      events.push('attribute-size')
      koffi.encode(size, 'size_t', 64)
      return 0
    }
    events.push('attribute-init')
    return 1
  })
  const updateProcThreadAttribute = vi.fn((_list, _flags, attribute: number, value: NativePtr) => {
    if (attribute === PROC_THREAD_ATTRIBUTE_JOB_LIST) {
      attachedJob = koffi.decode(value, PVOID) as NativePtr
      events.push('attach-job')
    }
    return 1
  })
  const api = {
    createJobObjectW: vi.fn(() => 50n),
    setInformationJobObject: vi.fn(() => 1),
    getStdHandle: vi.fn((selector: number) => BigInt(100 - selector)),
    setHandleInformation: vi.fn((_handle: NativePtr, _mask: number, flags: number) => {
      events.push(flags === 0 ? 'restore' : 'inherit')
      return 1
    }),
    initializeProcThreadAttributeList,
    updateProcThreadAttribute,
    deleteProcThreadAttributeList: vi.fn(() => { events.push('attribute-delete') }),
    terminateProcess: vi.fn(() => 1),
    closeHandle: vi.fn((handle: NativePtr) => { events.push(`close:${handle}`); return 1 }),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
    ...overrides,
    createProcessAsUserW,
  } as unknown as Win32ProcessBindings
  return {
    api,
    events,
    createProcessAsUserW,
    initializeProcThreadAttributeList,
    updateProcThreadAttribute,
    attachedJob: () => attachedJob,
  }
}

describe('spawnInheritedJobProcess', () => {
  const token = 70n as NativePtr

  it('attaches a restricted child to the Job inside CreateProcessAsUserW', () => {
    const {
      api,
      events,
      createProcessAsUserW,
      initializeProcThreadAttributeList,
      updateProcThreadAttribute,
      attachedJob,
    } = inheritedApi()
    const child = spawnInheritedJobProcess(api, {
      command: 'cmd.exe',
      args: ['/c', 'exit', '0'],
      cwd: 'C:\\work',
      token,
    })
    expect(child).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(events.indexOf('attach-job')).toBeLessThan(events.indexOf('create'))
    expect(events.indexOf('attribute-delete')).toBeGreaterThan(events.indexOf('create'))
    expect(initializeProcThreadAttributeList).toHaveBeenNthCalledWith(1, null, 1, 0, expect.anything())
    expect(initializeProcThreadAttributeList).toHaveBeenNthCalledWith(2, expect.any(Buffer), 1, 0, expect.anything())
    expect(updateProcThreadAttribute).toHaveBeenCalledWith(
      expect.any(Buffer),
      0,
      PROC_THREAD_ATTRIBUTE_JOB_LIST,
      expect.anything(),
      POINTER_SIZE,
      null,
      null,
    )
    expect(attachedJob()).toBe(50n)
    expect(createProcessAsUserW).toHaveBeenCalledWith(
      token,
      null,
      'cmd.exe /c exit 0',
      null,
      null,
      1,
      EXTENDED_STARTUPINFO_PRESENT,
      null,
      'C:\\work',
      expect.anything(),
      expect.anything(),
    )
  })

  it('restores already-enabled stdio and closes the Job when inheritance setup fails', () => {
    let calls = 0
    const closeHandle = vi.fn(() => 1)
    const setHandleInformation = vi.fn((_handle: NativePtr, _mask: number, flags: number) => {
      if (flags === 0) return 1
      calls += 1
      return calls === 2 ? 0 : 1
    })
    const { api } = inheritedApi({ closeHandle, setHandleInformation })
    expect(() => spawnInheritedJobProcess(api, {
      command: 'cmd.exe',
      args: [],
      cwd: 'C:\\work',
      token,
    })).toThrow(Win32Error)
    expect(setHandleInformation).toHaveBeenCalledWith(expect.anything(), 1, 0)
    expect(closeHandle).toHaveBeenCalledWith(50n)
  })

  it('captures a GetStdHandle error before Job cleanup changes last-error', () => {
    let lastError = 123
    const { api } = inheritedApi({
      getStdHandle: vi.fn(() => 0n as NativePtr),
      getLastError: vi.fn(() => lastError),
      closeHandle: vi.fn(() => { lastError = 999; return 1 }),
    })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'cmd.exe', args: [], cwd: 'C:\\work', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'GetStdHandle', win32Code: 123 })
  })

  it('captures a CreateProcess error before inheritance restoration changes last-error', () => {
    let lastError = 87
    const { api } = inheritedApi({
      createProcessAsUserW: vi.fn(() => 0),
      getLastError: vi.fn(() => lastError),
      setHandleInformation: vi.fn((_handle, _mask, flags) => {
        if (flags === 0) lastError = 999
        return 1
      }),
      closeHandle: vi.fn(() => { lastError = 998; return 1 }),
    })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'cmd.exe', args: [], cwd: 'C:\\work', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'CreateProcessAsUserW', win32Code: 87 })
  })

  it('closes the atomic Job when CreateProcessAsUserW returns a null thread handle', () => {
    const closeHandle = vi.fn(() => 1)
    const { api } = inheritedApi({
      closeHandle,
      createProcessAsUserW: vi.fn((_token, _app, _line, _pa, _ta, _inherit, _flags, _env, _cwd, _startup, info) => {
        koffi.encode(info, PROCESS_INFORMATION, {
          hProcess: 60n,
          hThread: 0n,
          dwProcessId: 1234,
          dwThreadId: 0,
        })
        return 1
      }),
    })
    expect(() => spawnInheritedJobProcess(api, {
      command: 'cmd.exe',
      args: [],
      cwd: 'C:\\work',
      token,
    })).toThrow('null process/thread handles')
    expect(closeHandle).toHaveBeenCalledWith(50n)
    expect(closeHandle).toHaveBeenCalledWith(60n)
  })
})

describe('wait and pipe cleanup', () => {
  const token = 70n as NativePtr

  it('waits when a pipe is temporarily empty before observing EOF', async () => {
    const closeHandle = vi.fn(() => 1)
    let peeks = 0
    const api = {
      peekNamedPipe: vi.fn((_handle, _buffer, _size, _read, available) => {
        peeks += 1
        if (peeks === 1) {
          koffi.encode(available, 'uint32', 0)
          return 1
        }
        return 0
      }),
      getLastError: vi.fn(() => 109),
      closeHandle,
    } as unknown as Win32ProcessBindings
    await expect(drainPipe(api, 80n as NativePtr)).resolves.toEqual(Buffer.alloc(0))
    expect(closeHandle).toHaveBeenCalledWith(80n)
  })

  it('checks caller-owned handle closure', () => {
    const closeHandle = vi.fn(() => 1)
    const api = { closeHandle } as unknown as Win32ProcessBindings
    expect(() => { closeHandleChecked(api, 80n as NativePtr, 'sandbox Job') }).not.toThrow()
    expect(closeHandle).toHaveBeenCalledWith(80n)

    const failing = {
      closeHandle: vi.fn(() => 0),
      getLastError: vi.fn(() => 6),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    expect(() => { closeHandleChecked(failing, 81n as NativePtr, 'sandbox Job') }).toThrow(Win32Error)
  })

  it('terminates a piped child when CreateProcess returns a null thread handle', () => {
    let nextPipe = 10n
    const terminateProcess = vi.fn(() => 1)
    const closeHandle = vi.fn(() => 1)
    const api = {
      createPipe: vi.fn((readSlot, writeSlot) => {
        koffi.encode(readSlot, PVOID, nextPipe++)
        koffi.encode(writeSlot, PVOID, nextPipe++)
        return 1
      }),
      setHandleInformation: vi.fn(() => 1),
      createProcessAsUserW: vi.fn((_token, _app, _line, _pa, _ta, _inherit, _flags, _env, _cwd, _startup, info) => {
        koffi.encode(info, PROCESS_INFORMATION, {
          hProcess: 60n,
          hThread: 0n,
          dwProcessId: 1234,
          dwThreadId: 0,
        })
        return 1
      }),
      terminateProcess,
      closeHandle,
    } as unknown as Win32ProcessBindings
    expect(() => spawnPipedProcess(api, {
      command: 'cmd.exe',
      args: [],
      cwd: 'C:\\work',
      token,
    })).toThrow('null process/thread handles')
    expect(terminateProcess).toHaveBeenCalledWith(60n, 1)
  })
})
