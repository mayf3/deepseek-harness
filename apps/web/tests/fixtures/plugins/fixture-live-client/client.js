/** Test package using the published registration protocol, locale and slots. */
window.__ModuleLoader__.load({
  id: '@fixture/live-client',
  factory(require) {
    const React = require('react')
    const { MenuAction } = require('@deepseek-ai/dsh-client-ui-primitives')
    const style = document.createElement('style')
    style.dataset.plugin = '@fixture/live-client'
    style.textContent = '[data-live-client] { color: rgb(12, 34, 56); position: absolute; bottom: 20px; right: 20px; }'
    document.head.append(style)
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const counters = document.documentElement.dataset
        counters.liveMounts = String(Number(counters.liveMounts ?? 0) + 1)
        ctx.effect(() => ctx.locale.register('fixtureLive', {
          zh: {
            active: '动态插件已启用', configSummary: '示例配置项', configForm: '动态插件配置', configField: '问候语', configSave: '保存',
            exportSession: '导出会话', copySessionId: '复制会话 ID',
          },
          en: {
            active: 'Live plugin enabled', configSummary: 'An example setting', configForm: 'Live plugin configuration', configField: 'Greeting', configSave: 'Save',
            exportSession: 'Export session', copySessionId: 'Copy session ID',
          },
        }))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'fixture-live-client', locale: 'fixtureLive',
        }, ({ t }) => React.createElement('div', { 'data-live-client': '' }, t('active'))))
        // The configuration of this bundle's one row, as the Plugins page renders it on the row's own page.
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: '@fixture/live-client#fixture-live-client', locale: 'fixtureLive',
        }, ({ t, view }) => view === 'summary'
          ? t('configSummary')
          : React.createElement('form', {
            'data-live-config': '',
            'aria-label': t('configForm'),
            onSubmit: (event) => {
              event.preventDefault()
              counters.liveSaves = String(Number(counters.liveSaves ?? 0) + 1)
            },
          },
          React.createElement('label', null, t('configField'), React.createElement('input', { name: 'greeting', defaultValue: 'hello' })),
          React.createElement('button', { type: 'submit' }, t('configSave')))))
        const actionInjected = () => ({
          selectAction(action, sessionId, displayTitle) {
            counters.sessionAction = action
            counters.sessionActionId = sessionId
            counters.sessionActionTitle = displayTitle
          },
        })
        const registerSessionAction = (id, order, label) => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.action', id, order, locale: 'fixtureLive', inject: actionInjected,
        }, ({ sessionId, displayTitle, selectAction, t }) => React.createElement(
          MenuAction,
          {
            onSelect: () => {
              selectAction(id, sessionId, displayTitle)
            },
          },
          t(label),
        ))
        ctx.slots.inject('sidebar.workspaces.session.menu.action', function* () {
          // The later registration receives the lower dynamic priority, but
          // list order remains the primary cross-id display policy.
          yield registerSessionAction('fixture.export-session', 100, 'exportSession')
          yield registerSessionAction('fixture.copy-session-id', 200, 'copySessionId')
        })
        ctx.effect(() => {
          const ping = () => { counters.liveHits = String(Number(counters.liveHits ?? 0) + 1) }
          window.addEventListener('dsh-fixture-ping', ping)
          return async () => {
            window.removeEventListener('dsh-fixture-ping', ping)
            await Promise.resolve()
            counters.liveDisposals = String(Number(counters.liveDisposals ?? 0) + 1)
          }
        })
      },
    }
  },
})
