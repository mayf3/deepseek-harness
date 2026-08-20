// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceViewStore } from '../src/client/stores.ts'

const V6 = 'dsh.workspace.view.v6'
const V7 = 'dsh.workspace.view.v7'

afterEach(() => { localStorage.clear() })

describe('workspace view v6→v7 migration', () => {
  it('keeps the first valid legacy tag as the exclusive group and preserves view state', () => {
    localStorage.setItem(V6, JSON.stringify({
      groupBy: 'tag',
      orderBy: 'manual',
      unreadOnly: true,
      groupExpansion: { alpha: true, 'tag:前端': true, 'tag:\u0000untagged': false },
      sessionOrderByAccount: { alpha: ['a'], __flat_session_order__: ['b', 'a'] },
      sessionUpdatedAtByAccount: { alpha: { a: 42 } },
      sessionMeta: {
        a: { tags: ['  ', '前端', '紧急'], parent: 'root', unread: true },
        b: { tags: ['\u0000', '后端'] },
      },
      knownTags: ['前端', '前端', ' 后端 '],
    }))
    const store = createWorkspaceViewStore().create()
    const state = store.getSnapshot()
    expect(state.groupBy).toBe('group')
    expect(state.orderBy).toBe('manual')
    expect(state.unreadOnly).toBe(true)
    expect(state.sessionMeta.a).toEqual({ group: '前端', parent: 'root', unread: true })
    expect(state.sessionMeta.b).toEqual({ group: '后端' })
    expect(state.knownGroups).toEqual(['前端', '后端'])
    expect(state.groupExpansion).toEqual({ alpha: true, 'group:前端': true, 'group:\u0000unassigned': false })
    expect(state.sessionOrderByAccount.alpha).toEqual(['a'])
    expect(state.sessionUpdatedAtByAccount.alpha).toEqual({ a: 42 })
    expect(JSON.parse(localStorage.getItem(V7) ?? 'null')).toMatchObject({ groupBy: 'group' })
  })

  it('never overwrites an existing v7 state', () => {
    localStorage.setItem(V6, JSON.stringify({ groupBy: 'tag', sessionMeta: { a: { tags: ['旧'] } } }))
    localStorage.setItem(V7, JSON.stringify({
      groupBy: 'flat', orderBy: 'updated', unreadOnly: false,
      groupExpansion: {}, sessionOrderByAccount: {}, sessionUpdatedAtByAccount: {},
      sessionMeta: { a: { group: '新' } }, knownGroups: ['新'],
    }))
    const state = createWorkspaceViewStore().create().getSnapshot()
    expect(state.groupBy).toBe('flat')
    expect(state.sessionMeta.a?.group).toBe('新')
  })

  it('falls back to v7 defaults when legacy JSON is invalid', () => {
    localStorage.setItem(V6, '{bad json')
    const state = createWorkspaceViewStore().create().getSnapshot()
    expect(state.groupBy).toBe('workspace')
    expect(state.sessionMeta).toEqual({})
    expect(state.knownGroups).toEqual([])
  })
})
