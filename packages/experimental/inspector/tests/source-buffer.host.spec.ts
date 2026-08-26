/** Worker-side source buffer behavior. */

import { describe, expect, it } from 'vitest'
import { inspectorId } from '../src/shared/bridge/ids.ts'
import { InspectorSourceBuffer } from '../src/shared/bridge/buffer.ts'

const sourceId = inspectorId<'InspectorSourceId'>('source-buffer-test', 'sourceId')
const generation = inspectorId<'InspectorSourceGeneration'>('generation-buffer-test', 'generation')

function buffer(maxQueuedRecords = 2): InspectorSourceBuffer {
  return new InspectorSourceBuffer({
    topics: ['*'],
    maxQueuedRecords,
    maxQueuedBytes: 32_768,
    maxRecordsPerFrame: 8,
    maxFrameBytes: 32_768,
  })
}

describe('Inspector source buffer', () => {
  it('absorbs pre-replacement queue loss exactly once', () => {
    const records = buffer(1)
    records.publish('test/event', { ordinal: 1 }, 1)
    records.publish('test/event', { ordinal: 2 }, 2)

    expect(records.replacement(sourceId, generation)).toMatchObject({
      nextSequence: 2,
      records: [],
    })
    expect(records.takeBatch(sourceId, generation)).toMatchObject({
      firstSequence: 2,
      droppedBefore: 0,
      records: [{ topic: 'test/event', payload: { ordinal: 2 } }],
    })
  })

  it('validates records before either carrier can enqueue them', () => {
    const records = buffer()

    expect(() => { records.publish('', {}, 1) }).toThrow('topic must contain 1 to 128 characters')
    expect(() => { records.publish('test/event', {}, Number.NaN) }).toThrow('monotonicMs must be finite')
  })
})
