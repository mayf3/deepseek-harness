/** Current-page Markdown actions; each mounted instance owns one page's copy request. */
import { defineComponent, h, onBeforeUnmount, ref } from 'vue'

type CopyState = 'idle' | 'copying' | 'copied' | 'requestFailed' | 'clipboardFailed'

const messages = {
  en: {
    copy: 'Copy Markdown',
    view: 'View Markdown',
    newTab: 'View Markdown (opens in a new tab)',
    copying: 'Copying…',
    copied: 'Markdown copied.',
    requestFailed: 'Could not load Markdown. Open View Markdown to copy it manually.',
    clipboardFailed: 'Could not copy. Open View Markdown to copy it manually.',
  },
  zh: {
    copy: '复制 Markdown',
    view: '查看 Markdown',
    newTab: '查看 Markdown（在新标签页打开）',
    copying: '正在复制…',
    copied: '已复制 Markdown。',
    requestFailed: '无法加载 Markdown，请打开“查看 Markdown”手动复制。',
    clipboardFailed: '复制失败，请打开“查看 Markdown”手动复制。',
  },
} satisfies Record<'en' | 'zh', Record<Exclude<CopyState, 'idle'> | 'copy' | 'view' | 'newTab', string>>

/**
 * Actions keyed by the owning layout to the current route and language.
 * Clipboard writes begin in the click gesture; their data resolves on demand.
 */
export const PageMarkdownActions = defineComponent({
  name: 'PageMarkdownActions',
  props: {
    path: { type: String, required: true },
    lang: { type: String, required: true },
  },
  setup(props) {
    const state = ref<CopyState>('idle')
    let controller: AbortController | undefined
    let disposed = false
    onBeforeUnmount(() => {
      disposed = true
      controller?.abort()
    })

    async function copy(): Promise<void> {
      if (state.value === 'copying') return
      state.value = 'copying'
      const clipboard: Partial<Clipboard> | undefined = (navigator as Partial<Navigator>).clipboard
      if (typeof ClipboardItem === 'undefined' || clipboard?.write === undefined) {
        state.value = 'clipboardFailed'
        return
      }
      const request = new AbortController()
      controller = request
      const outcome = { requestFailed: false }
      const content = fetch(`${props.path}?dsh-raw=1`, { signal: request.signal })
        .then(async (response) => {
          const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
          if (!response.ok || (type !== 'text/markdown' && type !== 'text/plain')) {
            throw new Error('Markdown response unavailable')
          }
          const text = await response.text()
          request.signal.throwIfAborted()
          return new Blob([text], { type: 'text/plain' })
        })
        .catch((error: unknown) => {
          outcome.requestFailed = true
          throw error
        })
      void content.catch((_error: unknown) => {
        // A denied write need not consume this promise; feedback belongs to the write outcome.
      })
      try {
        await clipboard.write([new ClipboardItem({ 'text/plain': content })])
        if (!disposed) state.value = 'copied'
      } catch (_error) {
        // Browser failures use localized feedback; their implementation-specific text is not user copy.
        if (!disposed) state.value = outcome.requestFailed ? 'requestFailed' : 'clipboardFailed'
      } finally {
        request.abort()
        if (controller === request) controller = undefined
      }
    }

    return () => {
      const text = messages[props.lang.startsWith('zh') ? 'zh' : 'en']
      return h('div', { class: 'page-markdown-actions' }, [
        h('div', { class: 'page-markdown-actions-controls' }, [
          h('button', { type: 'button', disabled: state.value === 'copying', onClick: copy },
            state.value === 'copying' ? text.copying : text.copy),
          h('a', { href: props.path, target: '_blank', rel: 'noopener', 'aria-label': text.newTab }, [
            text.view, h('span', { 'aria-hidden': 'true' }, ' ↗'),
          ]),
        ]),
        h('p', { class: 'page-markdown-actions-status', role: 'status', 'aria-atomic': 'true' },
          state.value === 'idle' ? '' : text[state.value]),
      ])
    }
  },
})
