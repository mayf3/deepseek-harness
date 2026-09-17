/** Browser recording bytes conform to the Host's fixed PCM format. */
import { afterEach, expect, it, vi } from 'vitest'
import { audioBase64, encodeWave, Recording, RecordingError } from '../src/client/audio.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('encodes bounded PCM samples and base64 across chunk boundaries', () => {
  const bytes = encodeWave(new Float32Array([-2, -0.5, 0, 0.5, 2]))
  const view = new DataView(bytes.buffer)
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
  expect(view.getUint32(24, true)).toBe(16000)
  expect(view.getUint32(40, true)).toBe(10)
  expect([0, 1, 2, 3, 4].map(i => view.getInt16(44 + i * 2, true))).toEqual([-32768, -16384, 0, 16384, 32767])
  const large = encodeWave(new Float32Array(17000))
  expect(Buffer.from(audioBase64(large), 'base64')).toEqual(Buffer.from(large))
})

it('reports unavailable recording and denied permission', async () => {
  vi.stubGlobal('navigator', {})
  const recording = new Recording(() => {})
  await expect(recording.start()).rejects.toMatchObject({ kind: 'unavailable' })
  vi.stubGlobal('MediaRecorder', function RecorderStub() {})
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError') } } })
  await expect(recording.start()).rejects.toMatchObject({ kind: 'permission' })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw new Error('device lost') } } })
  await expect(recording.start()).rejects.toThrow('device lost')
  expect(new RecordingError('empty').message).toBe('empty')
})

it('releases a microphone granted after cancellation', async () => {
  const permission = Promise.withResolvers<MediaStream>()
  const stop = vi.fn(), dispose = vi.fn()
  vi.stubGlobal('MediaRecorder', function RecorderStub() {})
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => permission.promise } })
  const recording = new Recording(dispose)
  const acquiring = recording.start()
  await recording.dispose()
  permission.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
  await expect(acquiring).rejects.toMatchObject({ kind: 'cancelled' })
  expect(stop).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
})

function captureFixture(options: { empty?: boolean; recorderError?: boolean; constructError?: boolean } = {}) {
  const trackStop = vi.fn(), close = vi.fn(async () => {}), disposed = vi.fn()
  const decoding = vi.fn(async (_data: ArrayBuffer) => ({ duration: 2 }))
  const rendering = vi.fn(async () => ({ getChannelData: () => new Float32Array([0.5, -0.5]) }))
  let failRecorder: () => void
  class Recorder {
    state = 'inactive'
    mimeType = 'audio/webm'
    ondataavailable?: (event: { data: Blob }) => void
    onstop?: () => void
    onerror?: () => void
    constructor() {
      if (options.constructError) throw new Error('recorder unavailable')
      failRecorder = () => { this.onerror!() }
    }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob() })
        if (!options.empty) this.ondataavailable?.({ data: new Blob(['final audio']) })
        if (options.recorderError) this.onerror?.()
        else this.onstop?.()
      })
    }
  }
  const offline = vi.fn(function Offline(_channels: number, _frames: number, _rate: number) {
    return { destination: {}, createBufferSource: () => ({ buffer: null, connect() {}, start() {} }), startRendering: rendering }
  })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: trackStop }] }) } })
  vi.stubGlobal('MediaRecorder', Recorder)
  vi.stubGlobal('AudioContext', function Audio() { return { state: 'running', close, decodeAudioData: decoding,
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    createAnalyser: () => ({ fftSize: 256, getFloatTimeDomainData: (buffer: Float32Array) => { buffer.fill(0.25) } }),
  } })
  vi.stubGlobal('OfflineAudioContext', offline)
  return { recording: new Recording(disposed), trackStop, close, disposed, decoding, rendering, offline,
    failRecorder: () => { failRecorder() } }
}

it('flushes final recording bytes, bounds timer overshoot and closes audio resources', async () => {
  const b = captureFixture()
  expect(b.recording.amplitude()).toBe(0)
  await b.recording.start()
  expect(b.recording.amplitude()).toBe(0.25)
  const result = await b.recording.stop(1)
  expect(new TextDecoder().decode(b.decoding.mock.calls[0]![0])).toBe('final audio')
  expect(b.offline).toHaveBeenCalledWith(1, 16000, 16000)
  expect(result).toEqual(encodeWave(new Float32Array([0.5, -0.5])))
  expect(b.trackStop).toHaveBeenCalled()
  expect(b.close).toHaveBeenCalledOnce()
  await b.recording.dispose()
  expect(b.close).toHaveBeenCalledOnce()
})

it.each([{ empty: true }, { recorderError: true }, { constructError: true }])('releases failed capture resources: %j', async (options) => {
  const b = captureFixture(options)
  if (options.constructError) await expect(b.recording.start()).rejects.toThrow('recorder unavailable')
  else { await b.recording.start(); await expect(b.recording.stop(120)).rejects.toMatchObject({ kind: 'empty' }) }
  expect(b.trackStop).toHaveBeenCalled()
  expect(b.close).toHaveBeenCalledOnce()
})

it('discards decoding results that finish after cancellation', async () => {
  const b = captureFixture(), decoded = Promise.withResolvers<{ duration: number }>()
  b.decoding.mockReturnValueOnce(decoded.promise)
  await b.recording.start()
  const stopping = b.recording.stop(120), rejected = expect(stopping).rejects.toMatchObject({ kind: 'cancelled' })
  await vi.waitFor(() => { expect(b.decoding).toHaveBeenCalledOnce() })
  await b.recording.dispose()
  decoded.resolve({ duration: 2 })
  await rejected
  expect(b.rendering).not.toHaveBeenCalled()
  await expect(b.recording.stop(120)).rejects.toMatchObject({ kind: 'empty' })
})

it('releases active capture on a spontaneous recorder error even when AudioContext.close rejects', async () => {
  const b = captureFixture()
  await b.recording.start()
  b.close.mockRejectedValueOnce(new Error('audio device disconnected'))
  b.failRecorder()
  await vi.waitFor(() => { expect(b.disposed).toHaveBeenCalledOnce() })
  expect(b.trackStop).toHaveBeenCalled()
  await expect(b.recording.stop(120)).rejects.toMatchObject({ kind: 'empty' })
})
