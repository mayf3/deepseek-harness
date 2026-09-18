import { expect, it } from 'vitest'
import { profile } from '../src/details.ts'

it.each([undefined, null, '', 'https://example.test/avatar.png'])('projects Platform picture %s', (picture) => {
  expect(profile({ id: 'user', email: 'masked@example.test', id_profile: { name: 'User', picture } }).avatarUrl)
    .toBe(picture || null)
})
