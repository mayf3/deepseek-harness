import type { LocaleFace } from '@deepseek-ai/dsh-client-ui-slots'

/** Static locale face for renderer tests that do not exercise locale switching. */
export const locale = {
  bind: () => key => key === 'brand.localBuild' ? 'DSH Local Build' : key,
  getSnapshot: () => ({
    active: 'en' as const,
    locales: [{ id: 'zh' as const, label: '中文' }, { id: 'en' as const, label: 'English' }],
    revision: 0,
  }),
  subscribe: () => () => {},
} satisfies LocaleFace
